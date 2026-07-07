const { getBeachWeather, clearCache } = require("../lib/beach-weather");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ success: false, message: "Method not allowed" });
    return;
  }

  try {
    if (req.query?.refresh === "1") clearCache();
    const data = await getBeachWeather();
    res.status(200).json({ success: true, ...data });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};
