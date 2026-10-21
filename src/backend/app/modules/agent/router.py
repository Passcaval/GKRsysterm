"""Authenticated admissions copilot with a streaming OpenAI-compatible model."""

from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import Field

from app.core.errors import DomainError, missing
from app.core.model import ModelCallFailed, ModelGateway, ModelNotConfigured
from app.core.security import current_user, throttle
from app.db.models import ChatProfileSignal, Conversation
from app.db.session import get_db
from app.modules.agent.profile_signals import (
    extract_profile_changes,
    signal_question,
)
from app.modules.agent.service import (
    add_message,
    build_context,
    build_messages,
    history_for,
    retrieve_units,
    search_terms,
    target_values,
)
from app.modules.community.schemas import StrictModel
from app.modules.profiles.service import current_profile

router = APIRouter(prefix="/api/v1", tags=["M1 chat"])
logger = logging.getLogger("agent.chat")


class ChatInput(StrictModel):
    message: str = Field(min_length=1, max_length=4000)
    conversationId: UUID | None = None


def _event(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


@router.post("/chat/stream")
def chat(data: ChatInput, request: Request, user=Depends(current_user), db=Depends(get_db)):
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
    profile = profile_record.data if profile_record else None
    terms = search_terms(data.message, profile)
    target_score, target_rank = target_values(profile, data.message)
    rows = retrieve_units(
        db,
        terms,
        target_score=target_score,
        target_rank=target_rank,
        profile=profile,
    )
    context, source_ids = build_context(rows)
    history = history_for(db, conversation.id)
    messages = build_messages(profile, context, history, data.message)
    user_message = add_message(db, conversation.id, user.id, "user", data.message)
    db.flush()
    changes = extract_profile_changes(profile, data.message) if profile_record else []
    signal = None
    if changes:
        signal = ChatProfileSignal(
            owner_id=user.id,
            conversation_id=conversation.id,
            message_id=user_message.id,
            changes=changes,
            source_ids=source_ids,
            query_text=data.message[:500],
        )
        db.add(signal)
    db.commit()

    conversation_id = conversation.id
    owner_id = user.id
    model_name = settings.model_name
    contract_version = getattr(request.app.state, "contract_version", "0.4")
    sessions = request.app.state.sessions
    signal_id = signal.id if signal else None
    expected_version = profile_record.version if profile_record else None
    question = signal_question(changes) if changes else ""

    def stream():
        chunks: list[str] = []
        saved = False
        try:
            yield _event(
                {
                    "type": "tool_start",
                    "tool": "official_search",
                    "text": "检索已发布的招生数据",
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
            else:
                yield _event(
                    {
                        "type": "tool_end",
                        "tool": "official_search",
                        "text": "未匹配到具体招生数据，将按一般信息回答",
                    }
                )
            if source_ids:
                yield _event({"type": "evidence", "source_ids": source_ids})
            if signal_id is not None:
                yield _event(
                    {
                        "type": "profile_update",
                        "signal_id": str(signal_id),
                        "changes": changes,
                        "expected_version": expected_version,
                        "question": question,
                        "source_ids": source_ids,
                    }
                )

            try:
                for delta in gateway.stream_text(
                    messages,
                    max_tokens=settings.model_max_output_tokens,
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
                yield _event({"type": "error", "text": "模型没有返回内容，请重试。"})
                return
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
            if not saved and chunks:
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
