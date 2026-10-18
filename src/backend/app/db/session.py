from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def configure_db(app, settings):
    engine = create_engine(settings.database_url, pool_pre_ping=True, hide_parameters=True)
    app.state.engine = engine
    app.state.sessions = sessionmaker(engine, expire_on_commit=False)


def get_db(request: Request):
    with request.app.state.sessions() as db:
        yield db
