import io
import json
import shutil
import subprocess
import wave
from pathlib import Path
from uuid import uuid4

from PIL import Image
from pypdf import PdfReader
from starlette.datastructures import UploadFile

from app.core.errors import DomainError


def validate_audio(content: bytes):
    if len(content) < 16:
        raise DomainError(415, "FILE_TYPE_UNSUPPORTED", "语音文件无效，请重新提交。")
    if not content.startswith(b"RIFF"):
        return validate_recorded_audio(content)
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


def validate_recorded_audio(content):
    # Decode through stdin with pipe-only protocols: no network or file references from media.
    probe, decoder = shutil.which("ffprobe"), shutil.which("ffmpeg")
    if not probe or not decoder:
        raise DomainError(
            503, "AUDIO_DECODER_UNAVAILABLE", "语音解析服务未就绪，请暂用 WAV 或文字证据。"
        )
    flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
    options = {"input": content, "capture_output": True, "timeout": 15, "creationflags": flags}
    try:
        inspected = subprocess.run(
            [
                probe,
                "-v",
                "error",
                "-protocol_whitelist",
                "pipe",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                "pipe:0",
            ],
            **options,
        )
        metadata = json.loads(inspected.stdout)
        streams = metadata.get("streams", [])
        if inspected.returncode or len(streams) != 1 or streams[0].get("codec_type") != "audio":
            raise ValueError()
        formats = set(metadata["format"]["format_name"].split(","))
        mime = (
            "audio/webm"
            if "webm" in formats
            else "audio/ogg"
            if "ogg" in formats
            else "audio/mpeg"
            if "mp3" in formats
            else "audio/mp4"
            if "mp4" in formats
            else None
        )
        if not mime:
            raise ValueError()
        decoded = subprocess.run(
            [
                decoder,
                "-v",
                "error",
                "-xerror",
                "-nostdin",
                "-protocol_whitelist",
                "pipe",
                "-i",
                "pipe:0",
                "-map",
                "0:a:0",
                "-vn",
                "-t",
                "121",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "s16le",
                "pipe:1",
            ],
            **options,
        )
        duration = len(decoded.stdout) / 16000
        if decoded.returncode or not 0 < duration <= 120:
            raise ValueError()
        return mime, duration
    except (ValueError, KeyError, subprocess.TimeoutExpired):
        raise DomainError(
            415,
            "FILE_TYPE_UNSUPPORTED",
            "语音须为完整可解码的 WAV/WebM/OGG/MP3/M4A，且不超过120秒。",
        ) from None


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
