"""Authenticated admissions copilot with a streaming OpenAI-compatible model."""

from __future__ import annotations

import json
import logging
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import Field

from app.core.errors import DomainError, missing
from app.core.model import ModelCallFailed, ModelGateway, ModelNotConfigured
from app.core.security import optional_user, throttle
from app.db.models import ChatProfileSignal, Conversation, now
from app.db.session import get_db
from app.modules.admissions.knowledge import knowledge_context, retrieve_knowledge, search_query
from app.modules.agent.profile_signals import (
    extract_profile_changes,
    signal_applied_question,
)
from app.modules.agent.service import (
    add_message,
    build_context,
    build_messages,
    build_school_context,
    history_for,
    missing_chat_fields,
    retrieve_schools,
    retrieve_units,
    search_terms,
    target_values,
)
from app.modules.community.schemas import StrictModel
from app.modules.profiles.service import (
    apply_chat_changes,
    conversation_profile,
    current_profile,
    merge_chat_values,
)

router = APIRouter(prefix="/api/v1", tags=["M1 chat"])
logger = logging.getLogger("agent.chat")


def _profile_state(record) -> dict:
    data = dict(record.data)
    data.update(
        {
            "version": record.version,
            "profileVersionId": str(record.id),
            "preferredSchools": data.get("schools", []),
            "rankCohort": data.get("rank_cohort"),
        }
    )
    return data


class ChatTurn(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatContext(StrictModel):
    province: str = Field(default="", max_length=30)
    year: int = Field(default=2026, ge=2000, le=2100)
    rank: int | None = Field(default=None, ge=1, le=5000000)
    subjects: list[Literal["物理", "化学", "生物", "政治", "历史", "地理", "技术"]] = Field(
        default_factory=list, max_length=3
    )
    cities: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list, max_length=5
    )
    interests: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list, max_length=5
    )
    schools: list[Annotated[str, Field(min_length=1, max_length=80)]] = Field(
        default_factory=list, max_length=5
    )


class ChatInput(StrictModel):
    message: str = Field(min_length=1, max_length=4000)
    conversationId: UUID | None = None
    history: list[ChatTurn] = Field(default_factory=list, max_length=8)
    profile_context: ChatContext | None = None


def _event(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


@router.post("/chat/stream")
def chat(data: ChatInput, request: Request, user=Depends(optional_user), db=Depends(get_db)):
    throttle(request, "chat")
    settings = request.app.state.settings
    factory = getattr(request.app.state, "model_gateway_factory", None)
    if factory is None and not settings.model_configured:
        raise DomainError(
            503,
            "MODEL_NOT_CONFIGURED",
            "未配置模型服务，无法使用领航员。请配置 MODEL_BASE_URL/MODEL_API_KEY/MODEL_NAME。",
        )
    try:
        gateway = (factory or ModelGateway)(settings)
    except ModelNotConfigured:
        raise DomainError(503, "MODEL_NOT_CONFIGURED", "未配置模型服务，无法使用领航员。") from None

    anonymous = user is None
    if anonymous:
        conversation = None
        profile_record = None
        prior_conversation = merge_chat_values(None, [])
        if data.profile_context:
            prior_conversation.update(data.profile_context.model_dump(exclude_none=True))
        for turn in [] if data.profile_context else data.history:
            if turn.role == "user":
                prior_conversation = merge_chat_values(
                    prior_conversation,
                    extract_profile_changes(prior_conversation, turn.content),
                )
        history = data.history
        user_message = None
    else:
        conversation = db.get(Conversation, data.conversationId) if data.conversationId else None
        if data.conversationId and (not conversation or conversation.owner_id != user.id):
            gateway.close()
            missing()
        if not conversation:
            conversation = Conversation(owner_id=user.id)
            db.add(conversation)
            db.commit()
            db.refresh(conversation)
        profile_record = current_profile(db, user.id)
        prior_conversation = conversation_profile(db, conversation.id)
        history = history_for(db, conversation.id)
        user_message = add_message(db, conversation.id, user.id, "user", data.message)
        db.flush()

    changes = extract_profile_changes(prior_conversation, data.message)
    if changes and not anonymous:
        global_changes = [
            change
            for change in changes
            if (profile_record.data if profile_record else {}).get(change.get("field"))
            != change.get("new")
        ]
        try:
            if global_changes:
                profile_record = apply_chat_changes(db, user.id, global_changes)
        except Exception:
            logger.exception("could not apply chat profile changes")
            changes = []
    conversation_values = (
        merge_chat_values(prior_conversation, changes) if changes else prior_conversation
    )

    terms = search_terms(data.message, conversation_values)
    target_score, target_rank = target_values(conversation_values, data.message)
    rows = retrieve_units(
        db,
        terms,
        target_score=target_score,
        target_rank=target_rank,
        profile=conversation_values,
    )
    school_rows = retrieve_schools(db, terms, conversation_values, data.message) if not rows else []
    context, source_ids = build_context(rows)
    school_context, school_source_ids = build_school_context(school_rows)
    source_ids = list(dict.fromkeys([*source_ids, *school_source_ids]))
    missing_fields = missing_chat_fields(conversation_values)
    missing_text = "、".join(missing_fields)
    fallback_text = (
        f"要给出可比较的院校和专业，我还需要：{missing_text}。你可以直接在这里告诉我。"
        if missing_fields
        else "我暂时没有生成有效回答，请稍后再试。"
    )
    messages = build_messages(
        conversation_values,
        context,
        history,
        data.message,
        school_context=school_context,
        missing_fields=missing_fields,
    )

    signal = None
    if changes and not anonymous:
        signal = ChatProfileSignal(
            owner_id=user.id,
            conversation_id=conversation.id,
            message_id=user_message.id,
            changes=changes,
            source_ids=source_ids,
            query_text=data.message[:500],
            status="confirmed",
            resolved_at=now(),
        )
        db.add(signal)
        db.flush()
    db.commit()

    conversation_id = conversation.id if conversation else uuid4()
    owner_id = user.id if user else None
    model_name = settings.model_name
    contract_version = getattr(request.app.state, "contract_version", "0.4")
    sessions = request.app.state.sessions
    event_signal_id = str(signal.id) if signal else (str(uuid4()) if changes else None)
    expected_version = profile_record.version if profile_record else 0
    question = signal_applied_question(changes) if changes else ""
    profile_payload = _profile_state(profile_record) if profile_record else None
    conversation_payload = {
        **conversation_values,
        "version": profile_record.version if profile_record else 0,
        "profileVersionId": str(profile_record.id) if profile_record else "",
        "preferredSchools": conversation_values.get("schools", []),
        "rankCohort": conversation_values.get("rank_cohort"),
    }

    def stream():
        chunks: list[str] = []
        saved = False
        stream_messages = messages
        try:
            yield _event(
                {
                    "type": "tool_start",
                    "tool": "official_search",
                    "text": "检索招生计划和全国院校名录",
                }
            )
            if rows:
                yield _event(
                    {
                        "type": "tool_end",
                        "tool": "official_search",
                        "text": f"匹配到 {len(rows)} 条招生数据、{len(source_ids)} 条来源",
                    }
                )
            elif school_rows:
                yield _event(
                    {
                        "type": "tool_end",
                        "tool": "official_search",
                        "text": (
                            f"未匹配到招生计划，找到 {len(school_rows)} 所全国院校；"
                            "仅含学校基础名录，不含专业和投档数据"
                        ),
                    }
                )
            else:
                yield _event(
                    {
                        "type": "tool_end",
                        "tool": "official_search",
                        "text": "未匹配到招生计划或全国院校名录数据",
                    }
                )
            web_query = search_query(data.message, conversation_values, terms)
            if settings.knowledge_configured and web_query:
                yield _event(
                    {"type": "tool_start", "tool": "web_search", "text": "联网查找官方招生资料"}
                )
                try:
                    with sessions.begin() as web_db:
                        web_sources = retrieve_knowledge(web_db, settings, web_query)
                        web_context = knowledge_context(web_sources)
                        source_ids.extend(
                            str(s.id) for s in web_sources if str(s.id) not in source_ids
                        )
                    stream_messages = build_messages(
                        conversation_values,
                        context,
                        history,
                        data.message,
                        school_context=school_context,
                        missing_fields=missing_fields,
                        web_context=web_context,
                    )
                    text = (
                        f"取得 {len(web_sources)} 份官方网页正文，回答附原始出处"
                        if web_sources
                        else "未取得可引用的招生正文，不用搜索摘要替代事实"
                    )
                except DomainError:
                    text = "联网资料暂不可用，继续依据已有资料回答"
                yield _event({"type": "tool_end", "tool": "web_search", "text": text})
            if source_ids:
                yield _event({"type": "evidence", "source_ids": source_ids})
            if event_signal_id is not None:
                payload = {
                    "type": "profile_update",
                    "signal_id": event_signal_id,
                    "applied": True,
                    "conversation_profile": conversation_payload,
                    "changes": changes,
                    "expected_version": expected_version,
                    "question": question,
                    "source_ids": source_ids,
                }
                if profile_payload is not None:
                    payload["profile"] = profile_payload
                yield _event(payload)

            try:
                for delta in gateway.stream_text(
                    stream_messages,
                    max_tokens=max(settings.model_max_output_tokens, 8000),
                    temperature=0.3,
                ):
                    if delta:
                        chunks.append(delta)
                        yield _event({"type": "delta", "text": delta})
            except ModelCallFailed as exc:
                logger.warning(
                    "chat model failed: conversation=%s status=%s",
                    conversation_id,
                    exc.status,
                )
                yield _event(
                    {
                        "type": "error",
                        "text": "模型服务暂时不可用，请稍后重试。",
                    }
                )
                return

            text = "".join(chunks).strip()
            if not text:
                text = fallback_text
                yield _event({"type": "delta", "text": text})
            if owner_id is not None:
                with sessions.begin() as save_db:
                    add_message(
                        save_db,
                        conversation_id,
                        owner_id,
                        "assistant",
                        text,
                        source_ids=source_ids,
                        model_name=model_name,
                    )
            saved = True
            done_key = "conversation_id" if contract_version == "0.4" else "conversationId"
            yield _event({"type": "done", done_key: str(conversation_id)})
        finally:
            if not saved and chunks and owner_id is not None:
                try:
                    with sessions.begin() as save_db:
                        add_message(
                            save_db,
                            conversation_id,
                            owner_id,
                            "assistant",
                            "".join(chunks).strip(),
                            source_ids=source_ids,
                            model_name=model_name,
                        )
                except Exception:
                    logger.exception("could not persist partial chat response")
            gateway.close()

    logger.info(
        "chat stream: conversation=%s terms=%s rows=%s sources=%s",
        conversation_id,
        len(terms),
        len(rows),
        len(source_ids),
    )
    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
