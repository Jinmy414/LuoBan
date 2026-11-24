FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --system --uid 10001 luoban && mkdir instance && chown luoban instance
COPY server/ server/
COPY index.html styles.css app.js auth.js ./
COPY assets/ assets/
ENV DATABASE=/app/instance/accounts.sqlite3
USER luoban
VOLUME ["/app/instance"]
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "server.app:create_app()"]
