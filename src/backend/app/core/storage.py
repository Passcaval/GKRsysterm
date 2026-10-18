import io
import wave
from pathlib import Path
from uuid import uuid4

from PIL import Image
from pypdf import PdfReader
from starlette.datastructures import UploadFile

from app.core.errors import DomainError


def validate_audio(content: bytes):
    try:
        with wave.open(io.BytesIO(content), "rb") as audio:
            duration = audio.getnframes() / audio.getframerate()
            if not 0 < duration <= 120 or audio.getnchannels() not in (1, 2):
                raise ValueError()
            if (
                len(audio.readframes(audio.getnframes()))
                != audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
            ):
                raise ValueError()
    except (wave.Error, EOFError, ValueError, ZeroDivisionError):
        raise DomainError(
            415, "FILE_TYPE_UNSUPPORTED", "语音须为完整的 PCM WAV 音频，且不超过 120 秒。"
        ) from None
    return "audio/wav", duration


def validate_document(content: bytes):
    try:
        if content.startswith(b"%PDF-"):
            reader = PdfReader(io.BytesIO(content), strict=True)
            if reader.is_encrypted or not 1 <= len(reader.pages) <= 20:
                raise ValueError()
            return "application/pdf"
        with Image.open(io.BytesIO(content)) as image:
            if image.format not in {"JPEG", "PNG"} or image.width * image.height > 20_000_000:
                raise ValueError()
            mime = "image/png" if image.format == "PNG" else "image/jpeg"
            image.verify()
            return mime
    except Exception:
        raise DomainError(
            415, "FILE_TYPE_UNSUPPORTED", "材料须为有效的 PNG、JPEG 或未加密 PDF。"
        ) from None


def save_blob(settings, content: bytes) -> str:
    root = Path(settings.storage_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    name = uuid4().hex + ".blob"
    path = root / name
    with path.open("xb") as file:
        file.write(content)
    path.chmod(0o600)
    return name


def blob_path(settings, key):
    root = Path(settings.storage_dir).resolve()
    path = (root / key).resolve()
    if path.parent != root:
        raise DomainError(404, "RESOURCE_NOT_FOUND", "材料不存在。")
    return path


async def read_upload(upload, settings):
    if not isinstance(upload, UploadFile):
        raise DomainError(422, "INVALID_INPUT", "附件字段必须是文件，请重新提交。")
    content = await upload.read(settings.max_upload_bytes + 1)
    if len(content) > settings.max_upload_bytes:
        raise DomainError(413, "FILE_TOO_LARGE", "附件不得超过 10 MiB。")
    if not content:
        raise DomainError(422, "INVALID_INPUT", "附件内容为空。")
    return content
