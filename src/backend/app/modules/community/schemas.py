from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class Login(StrictModel):
    login_type: Literal["email", "user_id"]
    identifier: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=256)


class Registration(StrictModel):
    nickname: str
    email: str
    password: str = Field(min_length=8, max_length=128)
    evidence_text: str | None = Field(default=None, max_length=3000)


class Decision(StrictModel):
    decision: Literal["approve", "reject"]
    expected_version: int = Field(ge=1)
    reason: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def rejection_reason(self):
        if self.decision == "reject" and not self.reason.strip():
            raise ValueError("Reject requires a reason")
        return self


class PostInput(StrictModel):
    schoolId: UUID
    topic: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=10000)


class ContentDecision(StrictModel):
    decision: Literal["approve", "reject"]
    reason: str = Field(min_length=1, max_length=2000)


class PostFeedbackInput(StrictModel):
    kind: Literal["helpful", "disagree", "appeal"]
    reason: str = Field(default="", max_length=2000)
