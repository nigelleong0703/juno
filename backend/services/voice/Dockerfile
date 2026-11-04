# Optional voice-call worker (compose profile `voice`; see deploy/compose.yml). Build context: backend/services/voice.
FROM python:3.12-slim
RUN useradd --create-home juno
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY juno_bridge.py worker.py ./
COPY --chmod=755 check-env.sh ./
USER juno
# The worker reaches agentd on loopback, so compose runs it in the app container's network namespace.
CMD ["./check-env.sh"]
