FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY src/backend/requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY src/backend/ ./src/backend/
COPY docs/ ./docs/
COPY config/ ./config/
WORKDIR /app/src/backend
ENV PYTHONPATH=/app/src/backend
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
