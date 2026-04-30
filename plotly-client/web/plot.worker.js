let firstTs = null;

function normalizeTimestampToSec(t) {
    const n = Number(t);
    const raw = Number.isFinite(n) ? n : Date.now() / 1000;
    let sec;

    if (raw > 1000000000000) sec = raw / 1000;
    else if (raw > 1000000000) sec = raw;
    else if (raw > 1000000) sec = raw / 1000000;
    else sec = raw;

    if (firstTs === null) firstTs = sec;

    const elapsed = sec - firstTs;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function isVectorSensor(s) {
    return s === "accel" || s === "gyro" || s === "mag";
}

function remapVector(type, x, y, z) {
    if (type === "accel") return { x: y, y: x, z: -z };
    if (type === "gyro") return { x, y, z };
    if (type === "mag") return { x, y, z };
    return { x, y, z };
}

function magnitude(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z);
}

function toDeg(rad) {
    return (rad * 180) / Math.PI;
}

function anglesDeg(x, y, z) {
    const phi = toDeg(Math.atan2(y, x));
    const rho = Math.sqrt(x * x + y * y);
    const theta = toDeg(Math.atan2(rho, z));

    return { phi_deg: phi, theta_deg: theta };
}

function normalizeItem(raw) {
    const type = String(raw.sensor ?? "").toLowerCase();
    const ts_s = normalizeTimestampToSec(raw.ts ?? raw.timestamp ?? Date.now());
    const ts_ms = Math.round(ts_s * 1000);

    if (isVectorSensor(type)) {
        const rx = safeNum(raw.x);
        const ry = safeNum(raw.y);
        const rz = safeNum(raw.z);

        if (rx === null || ry === null || rz === null) return null;

        const v = remapVector(type, rx, ry, rz);
        const mag = magnitude(v.x, v.y, v.z);
        const ang = anglesDeg(v.x, v.y, v.z);

        return {
            sensor: type,
            ts_s,
            ts_ms,
            x: v.x,
            y: v.y,
            z: v.z,
            mag,
            theta_deg: ang.theta_deg,
            phi_deg: ang.phi_deg,
            value: null,
        };
    }

    if (type === "temp" || type === "pressure" || type === "altitude") {
        const value = safeNum(raw.value);
        if (value === null) return null;

        return {
            sensor: type,
            ts_s,
            ts_ms,
            x: null,
            y: null,
            z: null,
            mag: null,
            theta_deg: null,
            phi_deg: null,
            value,
        };
    }

    return null;
}

function vectorFromObject(sensor, obj, ts) {
    if (!obj) return null;

    return normalizeItem({
        sensor,
        ts,
        x: obj.x ?? obj.X,
        y: obj.y ?? obj.Y,
        z: obj.z ?? obj.Z,
    });
}

function scalarFromValue(sensor, value, ts) {
    return normalizeItem({ sensor, ts, value });
}

function unpackDummy(raw) {
    if (!raw || typeof raw !== "object") return null;

    const ts = raw.ts ?? raw.timestamp ?? Date.now();
    const out = [];

    const accel = vectorFromObject("accel", raw.accel ?? raw.Accel, ts);
    const gyro = vectorFromObject("gyro", raw.gyro ?? raw.Gyro, ts);
    const mag = vectorFromObject("mag", raw.mag ?? raw.Mag, ts);

    if (accel) out.push(accel);
    if (gyro) out.push(gyro);
    if (mag) out.push(mag);

    const tempValue = raw.temperature ?? raw.temp ?? raw.Temperature;
    const pressureValue = raw.pressure ?? raw.Pressure;
    const altitudeValue = raw.altitude ?? raw.Altitude;

    const temp = scalarFromValue("temp", tempValue, ts);
    const pressure = scalarFromValue("pressure", pressureValue, ts);
    const altitude = scalarFromValue("altitude", altitudeValue, ts);

    if (temp) out.push(temp);
    if (pressure) out.push(pressure);
    if (altitude) out.push(altitude);

    return out.length ? out : null;
}

function unpackSerde(raw) {
    if (!raw || !raw.measurement) return null;

    const ts = raw.timestamp ?? Date.now();
    const keys = Object.keys(raw.measurement);

    if (keys.length !== 1) return null;

    const variant = keys[0];
    const values = raw.measurement[variant];

    if (Array.isArray(values) && values.length === 3 && variant !== "Baro") {
        return normalizeItem({
            sensor: variant.toLowerCase(),
            x: values[0],
            y: values[1],
            z: values[2],
            ts,
        });
    }

    if (variant === "Baro" && Array.isArray(values) && values.length === 3) {
        return [
            normalizeItem({ sensor: "temp", value: values[0], ts }),
            normalizeItem({ sensor: "pressure", value: values[1], ts }),
            normalizeItem({ sensor: "altitude", value: values[2], ts }),
        ].filter(Boolean);
    }

    return null;
}

self.onmessage = (ev) => {
    const raw = ev.data;
    let parsed;

    // Accept either a pre-parsed array (from SharedWorker path) or a JSON string
    // (kept for backwards-compatibility with any direct usage).
    if (Array.isArray(raw)) {
        parsed = raw;
    } else if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return;
        }
    } else {
        return;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    const out = [];

    for (const raw of items) {
        const serde = unpackSerde(raw);
        const dummy = serde ? null : unpackDummy(raw);
        const unpacked = serde ?? dummy;

        if (!unpacked) continue;

        const list = Array.isArray(unpacked) ? unpacked : [unpacked];

        for (const item of list) {
            if (item) out.push(item);
        }
    }

    if (out.length) self.postMessage(out);
};
