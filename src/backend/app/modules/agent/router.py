import json
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import Field

from app.core.errors import missing
from app.core.security import current_user
from app.db.models import Conversation
from app.db.session import get_db
from app.modules.community.schemas import StrictModel

router = APIRouter(prefix="/api/v1", tags=["M1 chat compatibility"])


class ChatInput(StrictModel):
    message: str = Field(min_length=1, max_length=3000)
    conversationId: UUID | None = None


@router.post("/chat/stream")
def chat(data: ChatInput, request: Request, user=Depends(current_user), db=Depends(get_db)):
    conversation = db.get(Conversation, data.conversationId) if data.conversationId else None
    if data.conversationId and (not conversation or conversation.owner_id != user.id):
        missing()
    if not conversation:
        conversation = Conversation(owner_id=user.id)
        db.add(conversation)
        db.commit()

    # M0–M1 does not claim to provide model reasoning. Fail transparently in the existing SSE shape.
    def stream():
        for event in (
            {"type": "error", "text": "M0–M1 尚未接入模型对话，请使用画像和规则推荐功能。"},
            {
                "type": "done",
                (
                    "conversation_id"
                    if getattr(request.app.state, "contract_version", "0.4") == "0.4"
                    else "conversationId"
                ): str(conversation.id),
            },
        ):
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
