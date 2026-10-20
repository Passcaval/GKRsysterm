"""Fuzzy suggestions for optional profile preferences.

Only published admission data and school metadata are exposed. The endpoint
is backend-only (not part of the shared v0.4 50-operation contract) and is
used by the profile form to help users fill cities and majors without typing
exact official names.
"""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from app.core.errors import result
from app.core.security import current_user
from app.db.models import AdmissionUnit, School
from app.db.session import get_db

router = APIRouter(prefix="/api/v1", tags=["profile suggestions"])


def fuzzy_score(query: str, text: str) -> int:
    q = (query or "").strip().lower()
    value = (text or "").lower()
    if not q or not value:
        return 0
    position = value.find(q)
    if position >= 0:
        return 1000 - position
    # Subsequence: tolerates a missing/extra character in the middle.
    cursor = 0
    matched = 0
    for char in q:
        found = value.find(char, cursor)
        if found < 0:
            break
        cursor = found + 1
        matched += 1
    if matched == len(q):
        return 500 - min(400, len(value) - len(q))
    common = len(set(q) & set(value))
    return int(600 * common / max(1, len(set(q)))) if common else 0


def _top(values, query: str, limit: int = 8):
    scored = [(fuzzy_score(query, value), value) for value in values if value]
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [value for score, value in scored if score >= 150][:limit]


@router.get("/me/profile/suggestions")
def suggestions(
    request: Request,
    q: str = Query(default="", max_length=50),
    user=Depends(current_user),
    db=Depends(get_db),
):
    query = (q or "").strip()
    if not query:
        return result(request, {"cities": [], "majors": [], "schools": []})

    unit_rows = db.execute(
        select(AdmissionUnit.school_id, AdmissionUnit.data["major"].astext).where(
            AdmissionUnit.active.is_(True)
        )
    ).all()
    majors = sorted({major for _, major in unit_rows if major})
    majors_by_school: dict = defaultdict(list)
    for school_id, major in unit_rows:
        if major:
            majors_by_school[school_id].append(major)

    schools = list(db.scalars(select(School)))
    cities = {
        (school.data or {}).get("city")
        for school in schools
        if (school.data or {}).get("city") not in (None, "", "待核对")
    }

    school_hits = []
    for school in schools:
        data = school.data or {}
        name = data.get("name") or ""
        city = data.get("city") or ""
        school_majors = [
            *[str(item) for item in (data.get("majors") or [])],
            *majors_by_school.get(school.id, []),
        ]
        haystack = " ".join([name, city, *school_majors])
        score = fuzzy_score(query, haystack)
        if score >= 150:
            school_hits.append((score, {"id": str(school.id), "name": name, "city": city}))
    school_hits.sort(key=lambda item: (-item[0], item[1]["name"]))

    return result(
        request,
        {
            "cities": _top(cities, query),
            "majors": _top(majors, query),
            "schools": [item for _, item in school_hits[:5]],
        },
    )
