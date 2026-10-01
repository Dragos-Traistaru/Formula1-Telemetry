from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
from datetime import timedelta

import fastf1
import pandas as pd

app = FastAPI()

# Allow the React dev server to call this API during development.
# Tighten this to your real frontend URL before deploying anywhere.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local dev only — tighten this before deploying anywhere
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache setup runs once at startup, not per request
fastf1.Cache.enable_cache('../fastf1_cache')


# ---------------------------------------------------------------------------
# Data model — this is YOUR schema, independent of FastF1's internal naming.
# Every field here should be filled in from FastF1 data inside get_session_laps().
# ---------------------------------------------------------------------------

class Lap(BaseModel):
    lap_number: int
    lap_time: Optional[float]       # seconds, e.g. 87.412
    sector_1: Optional[float]
    sector_2: Optional[float]
    sector_3: Optional[float]
    compound: Optional[str]         # e.g. "MEDIUM"
    tyre_life: Optional[int]        # laps on this set of tyres


class SessionLaps(BaseModel):
    track: str
    session_type: str               # e.g. "Race", "Qualifying"
    driver: str                     # 3-letter FastF1 driver code, e.g. "VER"
    laps: list[Lap]


# ---------------------------------------------------------------------------
# Telemetry — a DIFFERENT shape than Lap. A Lap is one row per lap.
# Telemetry is many samples WITHIN a single lap (speed/throttle/brake/gear
# measured continuously as the car goes around the track).
# ---------------------------------------------------------------------------

class TelemetryPoint(BaseModel):
    distance: float          # meters into the lap — use this as the x-axis,
                              # NOT time, so laps of different pace still line up
    speed: float              # km/h
    throttle: float           # 0-100 (%)
    brake: bool                # FastF1 gives this as True/False, not a percentage
    gear: int
    rpm: Optional[float]


class LapTelemetry(BaseModel):
    driver: str
    lap_number: int
    points: list[TelemetryPoint]


# ---------------------------------------------------------------------------
# This is the ONLY place FastF1-specific code should live.
# Everything outside this function should only ever see the Lap / SessionLaps
# schema above, never FastF1's raw objects or column names directly.
# ---------------------------------------------------------------------------

def timedelta_to_seconds(time: Optional[timedelta]) -> Optional[float]:
    if pd.isna(time):
        return None
    return time.total_seconds()


def get_session_laps(year: int, track: str, session_type: str, driver: str) -> SessionLaps:
    session = fastf1.get_session(year, track, session_type)
    session.load()

    driver_laps = session.laps.pick_driver(driver)

    laps: list[Lap] = []

    for _, driver_lap in driver_laps.iterrows():
        lap = Lap(
            lap_number=driver_lap['LapNumber'],
            lap_time=timedelta_to_seconds(driver_lap['LapTime']),
            sector_1=timedelta_to_seconds(driver_lap['Sector1Time']),
            sector_2=timedelta_to_seconds(driver_lap['Sector2Time']),
            sector_3=timedelta_to_seconds(driver_lap['Sector3Time']),
            compound=driver_lap['Compound'],
            tyre_life=driver_lap['TyreLife'],
        )
        laps.append(lap)

    return SessionLaps(
        track=track,
        session_type=session_type,
        driver=driver,
        laps=laps,
    )


def get_lap_telemetry(year: int, track: str, session_type: str, driver: str, lap_number: int) -> LapTelemetry:
    session = fastf1.get_session(year, track, session_type)
    session.load()

    driver_laps = session.laps.pick_driver(driver)

    lap_analyze = driver_laps.pick_laps(lap_number)

    points: list[TelemetryPoint] = []

    if (lap_analyze.empty):
        return LapTelemetry(
        driver=driver,
        lap_number=lap_number,
        points=points
    )

    telemetrys = lap_analyze.get_telemetry()


    for _, telemetry in telemetrys.iterrows():
        point = TelemetryPoint(
            distance=telemetry['Distance'],
            speed=telemetry['Speed'],
            throttle=telemetry['Throttle'],
            brake=none_if_missing(telemetry['Brake']),
            gear=none_if_missing(telemetry['nGear']),
            rpm=none_if_missing(telemetry['RPM']),
        )
        points.append(point)

    return LapTelemetry(
        driver=driver,
        lap_number=lap_number,
        points=points
    )

def none_if_missing(value):
    return None if pd.isna(value) else value


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
def read_root():
    return {"message": "F1 dashboard API is running"}


@app.get("/laps", response_model=SessionLaps)
def read_laps(year: int, track: str, driver: str, session_type: str = "R"):
    # session_type follows FastF1's convention: "R" = Race, "Q" = Qualifying,
    # "FP1"/"FP2"/"FP3" = practice sessions
    # driver is FastF1's 3-letter code, e.g. "VER", "HAM", "LEC"
    return get_session_laps(year, track, session_type, driver)


@app.get("/telemetry", response_model=LapTelemetry)
def read_telemetry(year: int, track: str, driver: str, lap_number: int, session_type: str = "R"):
    return get_lap_telemetry(year, track, session_type, driver, lap_number)


# ---------------------------------------------------------------------------
# Static frontend
# Mounted LAST, and specifically NOT at "/", so it can't swallow /laps or any
# future API route. Put your index.html, style.css, app.js into a folder
# named "frontend" next to this file. Visit it at localhost:8000/static/
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="../frontend", html=True), name="static")