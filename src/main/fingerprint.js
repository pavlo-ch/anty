// Fingerprint generation and injection scripts for anti-detect browser
// Based on real-world browser fingerprint data

// ===== FINGERPRINT PROFILES =====
// Each profile ties OS + Browser + UA + WebGL + Screen together realistically
const FINGERPRINT_PROFILES = [
  // Windows 11 — Chrome 146
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x00000008) Direct3D11 vs_5_0 ps_5_0, D3D11)', renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 3440, height: 1440 }],
    cpuCores: [4, 6, 8, 10, 12, 16], memoryGb: [4, 8, 16, 32],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }],
    cpuCores: [4, 6, 8, 10, 12], memoryGb: [8, 16],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1536, height: 864 }],
    cpuCores: [4, 6, 8], memoryGb: [4, 8, 16],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00009B41) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }],
    cpuCores: [6, 8, 10, 12, 16], memoryGb: [8, 16, 32],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }],
    cpuCores: [4, 8, 12], memoryGb: [8, 16],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }],
    cpuCores: [8, 12, 16], memoryGb: [16, 32],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }],
    cpuCores: [6, 8, 12], memoryGb: [8, 16],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }],
    cpuCores: [6, 8], memoryGb: [8, 16],
  },

  // Android — Chrome 146 (Mobile)
  {
    os: 'Android 16.0', osShort: 'Android', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
    webgl: { vendor: 'Qualcomm', renderer: 'Mali-G68' },
    screens: [{ width: 384, height: 832 }],
    cpuCores: [4, 6, 8], memoryGb: [4, 6, 8],
    mobile: true,
  },

  // macOS — Chrome 146
  {
    os: 'Mac OS X 26.3.0', osShort: 'Mac', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)' },
    screens: [{ width: 1512, height: 982 }],
    cpuCores: [8, 10], memoryGb: [16, 32],
  },
  {
    os: 'Mac OS X 26.3.0', osShort: 'Mac', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)' },
    screens: [{ width: 3840, height: 2160 }, { width: 1440, height: 900 }],
    cpuCores: [10, 12], memoryGb: [32, 64],
  },

  // macOS — Safari
  {
    os: 'Mac OS X 14.8.4', osShort: 'Mac', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 617, Unspecified Version)' },
    screens: [{ width: 1440, height: 900 }],
    cpuCores: [4, 8], memoryGb: [8, 16],
  },

  // iPhone — Safari (for reference)
  {
    os: 'iPhone OS 26.3', osShort: 'iOS', browser: 'Safari', browserVersion: '146.0.7680.38',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_3_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/146.0.7680.38 Safari/605.1.15',
    platform: 'iPhone',
    webgl: { vendor: 'Apple Inc.', renderer: 'Apple GPU' },
    screens: [{ width: 393, height: 852 }],
    cpuCores: [6], memoryGb: [6, 8],
    mobile: true,
  },

  // macOS — Safari 18.6
  {
    os: 'Mac OS X 10.15', osShort: 'Mac', browser: 'Safari', browserVersion: '18.6',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    platform: 'MacIntel',
    webgl: { vendor: 'Apple Inc.', renderer: 'Apple GPU' },
    screens: [{ width: 1920, height: 1080 }],
    cpuCores: [8, 10], memoryGb: [8, 16, 32],
  },

  // Windows — Firefox
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Firefox', browserVersion: '132.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }],
    cpuCores: [4, 6, 8], memoryGb: [8, 16],
  },

  // Windows — Edge
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Edge', browserVersion: '131.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }],
    cpuCores: [8, 12, 16], memoryGb: [16, 32],
  },

  // Windows — Chrome 142
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '142.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }],
    cpuCores: [4, 6, 8, 12, 16], memoryGb: [8, 16, 32],
  },
  {
    os: 'Windows 11', osShort: 'Win', browser: 'Chrome', browserVersion: '142.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }],
    cpuCores: [8, 12, 16], memoryGb: [16, 32],
  },
  {
    os: 'Windows 10', osShort: 'Win', browser: 'Chrome', browserVersion: '142.0.0',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    platform: 'Win32',
    webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    screens: [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }],
    cpuCores: [4, 6, 8], memoryGb: [8, 16],
  },

  // Linux — Chrome
  {
    os: 'Linux', osShort: 'Linux', browser: 'Chrome', browserVersion: '146.0.0',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    webgl: { vendor: 'Google Inc. (Mesa)', renderer: 'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL ES 3.1)' },
    screens: [{ width: 1920, height: 1080 }],
    cpuCores: [4, 8], memoryGb: [8, 16],
  },
];

const FONT_SETS = [
  ['Arial', 'Verdana', 'Helvetica', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Brush Script MT', 'Segoe UI'],
  ['Arial', 'Verdana', 'Helvetica', 'Impact', 'Comic Sans MS', 'Times New Roman', 'Courier New', 'Lucida Console', 'Palatino Linotype', 'Segoe UI'],
  ['Arial', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Times New Roman', 'Courier New', 'Consolas', 'Cambria', 'Calibri'],
  ['Arial', 'Verdana', 'Tahoma', 'Times New Roman', 'Georgia', 'Courier New', 'Lucida Sans Unicode', 'Book Antiqua', 'Monaco'],
  ['Arial', 'Helvetica', 'Geneva', 'Verdana', 'Optima', 'Futura', 'Times New Roman', 'Courier New', 'Menlo', 'Monaco', 'San Francisco'],
  ['Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman', 'Georgia', 'Courier New', '.AppleSystemUIFont', 'Helvetica Neue'],
];

const LANGUAGES = [
  { lang: 'en-US', langs: ['en-US', 'en'], timezone: 'America/New_York', country: 'US', flag: '🇺🇸' },
  { lang: 'en-US', langs: ['en-US', 'en'], timezone: 'America/Chicago', country: 'US', flag: '🇺🇸' },
  { lang: 'en-US', langs: ['en-US', 'en'], timezone: 'America/Los_Angeles', country: 'US', flag: '🇺🇸' },
  { lang: 'en-GB', langs: ['en-GB', 'en'], timezone: 'Europe/London', country: 'GB', flag: '🇬🇧' },
  { lang: 'de-DE', langs: ['de-DE', 'de', 'en'], timezone: 'Europe/Berlin', country: 'DE', flag: '🇩🇪' },
  { lang: 'fr-FR', langs: ['fr-FR', 'fr', 'en'], timezone: 'Europe/Paris', country: 'FR', flag: '🇫🇷' },
  { lang: 'pl-PL', langs: ['pl-PL', 'pl', 'en'], timezone: 'Europe/Warsaw', country: 'PL', flag: '🇵🇱' },
  { lang: 'uk-UA', langs: ['uk-UA', 'uk', 'en'], timezone: 'Europe/Kyiv', country: 'UA', flag: '🇺🇦' },
  { lang: 'es-ES', langs: ['es-ES', 'es', 'en'], timezone: 'Europe/Madrid', country: 'ES', flag: '🇪🇸' },
  { lang: 'it-IT', langs: ['it-IT', 'it', 'en'], timezone: 'Europe/Rome', country: 'IT', flag: '🇮🇹' },
  { lang: 'pt-BR', langs: ['pt-BR', 'pt', 'en'], timezone: 'America/Sao_Paulo', country: 'BR', flag: '🇧🇷' },
  { lang: 'ja-JP', langs: ['ja-JP', 'ja', 'en'], timezone: 'Asia/Tokyo', country: 'JP', flag: '🇯🇵' },
  { lang: 'nl-NL', langs: ['nl-NL', 'nl', 'en'], timezone: 'Europe/Amsterdam', country: 'NL', flag: '🇳🇱' },
  { lang: 'tr-TR', langs: ['tr-TR', 'tr', 'en'], timezone: 'Europe/Istanbul', country: 'TR', flag: '🇹🇷' },
  { lang: 'ko-KR', langs: ['ko-KR', 'ko', 'en'], timezone: 'Asia/Seoul', country: 'KR', flag: '🇰🇷' },
  { lang: 'zh-CN', langs: ['zh-CN', 'zh', 'en'], timezone: 'Asia/Shanghai', country: 'CN', flag: '🇨🇳' },
  { lang: 'vi-VN', langs: ['vi-VN', 'vi', 'en'], timezone: 'Asia/Ho_Chi_Minh', country: 'VN', flag: '🇻🇳' },
  { lang: 'th-TH', langs: ['th-TH', 'th', 'en'], timezone: 'Asia/Bangkok', country: 'TH', flag: '🇹🇭' },
];

function countryCodeToFlag(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...code.split('').map((ch) => 127397 + ch.charCodeAt(0)));
}

function getLocaleByCountry(countryCode, timezone) {
  const code = String(countryCode || '').trim().toUpperCase();
  const tz = String(timezone || '').trim();
  if (!code) return null;

  const candidates = LANGUAGES.filter((item) => item.country === code);
  if (candidates.length === 0) return null;

  const exactTz = tz ? candidates.find((item) => item.timezone === tz) : null;
  const picked = exactTz || candidates[0];
  return {
    lang: picked.lang,
    langs: [...picked.langs],
    timezone: tz || picked.timezone,
    country: code,
    flag: picked.flag || countryCodeToFlag(code),
  };
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Windows Chrome hardware templates (GPU pools per tier).
 * Used when generating profiles for any Chrome version dynamically.
 */
const WIN_CHROME_WEBGL_POOL = [
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)',           screens: [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }], cpuCores: [4, 6, 8, 12], memoryGb: [8, 16] },
  { vendor: 'Google Inc. (Intel)',  renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',           screens: [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }],  cpuCores: [4, 6, 8],     memoryGb: [8, 16] },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)',                        screens: [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }], cpuCores: [8, 12, 16],   memoryGb: [16, 32] },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',                        screens: [{ width: 1920, height: 1080 }],                                 cpuCores: [8, 12],       memoryGb: [16, 32] },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)',                  screens: [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }],  cpuCores: [6, 8, 12],    memoryGb: [8, 16] },
  { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',                             screens: [{ width: 1920, height: 1080 }],                                 cpuCores: [6, 8],        memoryGb: [16, 32] },
  { vendor: 'Google Inc. (AMD)',    renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',                                 screens: [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }],  cpuCores: [4, 6, 8],     memoryGb: [8, 16] },
];

// Intel Macs — MacBook Pro/Air pre-2022
const MAC_INTEL_WEBGL_POOL = [
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 617, Unspecified Version)',         screens: [{ width: 1440, height: 900 }, { width: 1280, height: 800 }],  cpuCores: [4],    memoryGb: [8, 16] },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris Plus Graphics 640, Unspecified Version)',   screens: [{ width: 1440, height: 900 }],                                 cpuCores: [2, 4], memoryGb: [8] },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, Unspecified Version)',         screens: [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }],  cpuCores: [6, 8], memoryGb: [16, 32] },
  { vendor: 'Google Inc. (AMD)',   renderer: 'ANGLE (AMD, AMD Radeon Pro 5500M, Unspecified Version)',                screens: [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }],  cpuCores: [6, 8], memoryGb: [16] },
];

// Apple Silicon Macs — MacBook Pro/Air M1/M2/M3 (2021+)
const MAC_APPLE_WEBGL_POOL = [
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',     screens: [{ width: 1440, height: 900 }, { width: 2560, height: 1600 }], cpuCores: [8],      memoryGb: [8, 16] },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', screens: [{ width: 1512, height: 982 }, { width: 1920, height: 1200 }], cpuCores: [8, 10],  memoryGb: [16, 32] },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version)', screens: [{ width: 1512, height: 982 }],                                 cpuCores: [10],     memoryGb: [32, 64] },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',     screens: [{ width: 1440, height: 900 }, { width: 2560, height: 1664 }], cpuCores: [8],      memoryGb: [8, 16, 24] },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', screens: [{ width: 1512, height: 982 }, { width: 1920, height: 1200 }], cpuCores: [10, 12], memoryGb: [16, 32] },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',     screens: [{ width: 1440, height: 900 }],                                 cpuCores: [8],      memoryGb: [8, 16] },
  { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)', screens: [{ width: 1512, height: 982 }],                                 cpuCores: [11, 12], memoryGb: [18, 36] },
];

/**
 * Pick a Mac GPU pool automatically based on Chrome version.
 * Chrome version ≈ release date → hints at which Macs were in use.
 *   < 100  (pre 2022)  → almost all Intel
 *   100-119 (2022-2023)→ mostly Intel, some Apple Silicon (30%)
 *   120-129 (2024)     → mixed 50/50
 *   130+   (late 2024+)→ leaning Apple Silicon (65%)
 */
function pickMacWebglPool(majorVersion) {
  const v = Number(majorVersion) || 0;
  let appleChance;
  if (v < 100)       appleChance = 0.05;
  else if (v < 120)  appleChance = 0.30;
  else if (v < 130)  appleChance = 0.50;
  else               appleChance = 0.65;
  return Math.random() < appleChance ? MAC_APPLE_WEBGL_POOL : MAC_INTEL_WEBGL_POOL;
}

// Combined pool for backward compat (used by static profiles)
const MAC_CHROME_WEBGL_POOL = [...MAC_INTEL_WEBGL_POOL, ...MAC_APPLE_WEBGL_POOL];

/**
 * Generate a synthetic FINGERPRINT_PROFILE entry for any Chrome version on any OS.
 * Used when the exact version isn't in the static list.
 */
function buildDynamicProfile(osShort, browser, versionStr, pool) {
  const hw = randomItem(pool);
  const osNames = {
    Win:     `Windows ${versionStr >= '130' ? '11' : '10'}`,
    Mac:     'Mac OS X 10.15',
    Linux:   'Linux',
    Android: 'Android',
    iOS:     'iPhone OS',
  };
  const uaTemplates = {
    Win:   `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionStr}.0 Safari/537.36`,
    Mac:   `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionStr}.0 Safari/537.36`,
    Linux: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionStr}.0 Safari/537.36`,
  };
  const platforms = { Win: 'Win32', Mac: 'MacIntel', Linux: 'Linux x86_64' };
  return {
    os: osNames[osShort] || osShort,
    osShort,
    browser,
    browserVersion: `${versionStr}.0.0`,
    ua: uaTemplates[osShort] || uaTemplates.Win,
    platform: platforms[osShort] || 'Win32',
    webgl: { vendor: hw.vendor, renderer: hw.renderer },
    screens: hw.screens,
    cpuCores: hw.cpuCores,
    memoryGb: hw.memoryGb,
    _dynamic: true,
  };
}

/**
 * Parse a User-Agent string and return { osShort, browser, version, mobile }
 */
function parseUA(ua) {
  if (!ua) return null;
  const s = ua.trim();
  let mobile = /Mobile|Android|iPhone|iPad/i.test(s);

  // OS detection
  let osShort = 'Win';
  if (/iPhone/i.test(s)) osShort = 'iOS';
  else if (/iPad/i.test(s)) osShort = 'iOS';
  else if (/Android/i.test(s)) osShort = 'Android';
  else if (/Macintosh|Mac OS X/i.test(s)) osShort = 'Mac';
  else if (/X11|Linux/i.test(s)) osShort = 'Linux';
  else if (/Windows/i.test(s)) osShort = 'Win';

  // Browser detection (order matters — Edge before Chrome)
  let browser = 'Chrome';
  let version = '';
  const edgM = s.match(/Edg\/(\d+)/i);
  const ffM = s.match(/Firefox\/(\d+)/i);
  const crsM = s.match(/CriOS\/(\d+)/i);
  const chrM = s.match(/Chrome\/(\d+)/i);
  const safM = s.match(/Version\/(\d+)/i);
  if (edgM) { browser = 'Edge'; version = edgM[1]; }
  else if (ffM) { browser = 'Firefox'; version = ffM[1]; }
  else if (crsM) { browser = 'Chrome'; version = crsM[1]; mobile = true; }
  else if (chrM) { browser = 'Chrome'; version = chrM[1]; }
  else if (safM) { browser = 'Safari'; version = safM[1]; }

  return { osShort, browser, version: `${version}.0.0`, mobile };
}

/**
 * Generate a fingerprint from an arbitrary UA string.
 * Finds the best matching profile (same OS + browser + version), overrides the UA.
 * For unknown Chrome versions — generates a realistic synthetic hardware profile.
 */
function generateFingerprintFromUA(ua) {
  const parsed = parseUA(ua);
  if (!parsed) return generateFingerprint();

  // Try exact profile match first
  const exactMatch = FINGERPRINT_PROFILES.find(p => p.ua === ua);
  if (exactMatch) return generateFingerprint(null, exactMatch);

  // Try same OS + browser + same major version
  const majorVer = parsed.version.split('.')[0];
  const sameVersion = FINGERPRINT_PROFILES.filter(p =>
    p.osShort === parsed.osShort &&
    p.browser === parsed.browser &&
    p.browserVersion.startsWith(majorVer + '.')
  );
  if (sameVersion.length > 0) {
    const fp = generateFingerprint(null, randomItem(sameVersion));
    fp.userAgent = ua;
    return fp;
  }

  // Same OS + browser (any version) — use hardware, override UA
  const sameOsBrowser = FINGERPRINT_PROFILES.filter(p =>
    p.osShort === parsed.osShort &&
    p.browser === parsed.browser &&
    !p.mobile === !parsed.mobile
  );
  if (sameOsBrowser.length > 0) {
    const fp = generateFingerprint(null, randomItem(sameOsBrowser));
    fp.userAgent = ua;
    fp.browserVersion = parsed.version;
    return fp;
  }

  // Unknown version — generate synthetic profile from GPU pool
  const gpuPool = parsed.osShort === 'Mac'
    ? pickMacWebglPool(majorVer)   // auto Intel vs Apple Silicon by Chrome version
    : WIN_CHROME_WEBGL_POOL;
  const syntheticProfile = buildDynamicProfile(parsed.osShort, parsed.browser, majorVer, gpuPool);
  const fp = generateFingerprint(null, syntheticProfile);
  fp.userAgent = ua;
  fp.browserVersion = parsed.version;
  return fp;
}

function generateFingerprint(customUA, _profileOverride) {
  // Pick a random fingerprint profile (excluding mobile for desktop browser)
  const desktopProfiles = FINGERPRINT_PROFILES.filter(p => !p.mobile);
  const profile = _profileOverride
    ? _profileOverride
    : customUA
      ? FINGERPRINT_PROFILES.find(p => p.ua === customUA) || randomItem(desktopProfiles)
      : randomItem(desktopProfiles);

  const screen = randomItem(profile.screens);
  const fonts = randomItem(FONT_SETS);
  // Locale is set to a deterministic English baseline.
  // Country/timezone are later synced from proxy/direct IP in main process.
  const locale = {
    lang: 'en-US',
    langs: ['en-US', 'en'],
    timezone: 'America/New_York',
    country: 'US',
    flag: countryCodeToFlag('US'),
  };
  const cpuCores = randomItem(profile.cpuCores);
  const memoryGb = randomItem(profile.memoryGb);
  const maxTouchPoints = profile.mobile ? randomItem([1, 5, 10]) : 0;
  const noiseSeed = Math.random();

  return {
    userAgent: profile.ua,
    platform: profile.platform,
    osName: profile.os,
    osShort: profile.osShort,
    browserName: profile.browser,
    browserVersion: profile.browserVersion,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: screen.height - randomInt(30, 60),
      colorDepth: 24,
      pixelRatio: screen.width > 2000 ? randomItem([1.5, 2]) : 1,
    },
    webgl: {
      vendor: profile.webgl.vendor,
      renderer: profile.webgl.renderer,
    },
    webgpu: {
      mode: 'mask',
    },
    fonts: fonts,
    locale: {
      language: locale.lang,
      languages: locale.langs,
      timezone: locale.timezone,
      country: locale.country,
      flag: locale.flag,
    },
    hardware: {
      cpuCores: cpuCores,
      memoryGb: memoryGb,
      maxTouchPoints: maxTouchPoints,
    },
    canvas: {
      mode: 'noise',
      noiseSeed: noiseSeed,
      noiseIntensity: Math.random() * 0.015,
    },
    audio: {
      mode: 'noise',
      noiseSeed: Math.random(),
      noiseIntensity: 0.0001 + Math.random() * 0.0003,
    },
    webrtc: {
      mode: 'disabled',
    },
    mediaDevices: {
      mode: 'emulate',
      audioInputs: randomInt(1, 3),
      audioOutputs: randomInt(1, 2),
      videoInputs: randomInt(0, 2),
    },
    clientRects: {
      mode: 'noise',
      noiseSeed: Math.random(),
      noiseIntensity: 0.001 + Math.random() * 0.004,
    },
    speech: {
      mode: 'emulate',
    },
    webglImage: {
      mode: 'noise',
    },
    windowSize: {
      mode: 'emulate',
    },
  };
}

function buildInjectionScript(fingerprint) {
  return `
(function() {
  'use strict';
  
  const fp = ${JSON.stringify(fingerprint)};

  // ===== UTIL: stealth property override on prototype =====
  function stealthOverride(obj, prop, getter) {
    const proto = Object.getPrototypeOf(obj);
    if (proto && prop in proto) {
      Object.defineProperty(proto, prop, {
        get: getter,
        configurable: true,
        enumerable: true,
      });
    } else {
      Object.defineProperty(obj, prop, {
        get: getter,
        configurable: true,
        enumerable: true,
      });
    }
  }

  // ===== UTIL: make function look native =====
  function makeNative(fn, name) {
    const orig = fn.toString;
    fn.toString = function() { return 'function ' + name + '() { [native code] }'; };
    if (name) Object.defineProperty(fn, 'name', { value: name, configurable: true });
    return fn;
  }

  // ===== 1. USER AGENT & PLATFORM =====
  stealthOverride(navigator, 'userAgent', () => fp.userAgent);
  stealthOverride(navigator, 'platform', () => fp.platform);
  stealthOverride(navigator, 'appVersion', () => fp.userAgent.replace('Mozilla/', ''));
  
  // ===== 2. HARDWARE =====
  stealthOverride(navigator, 'hardwareConcurrency', () => fp.hardware.cpuCores);
  stealthOverride(navigator, 'deviceMemory', () => fp.hardware.memoryGb);
  stealthOverride(navigator, 'maxTouchPoints', () => fp.hardware.maxTouchPoints);

  // ===== 3. SCREEN =====
  stealthOverride(screen, 'width', () => fp.screen.width);
  stealthOverride(screen, 'height', () => fp.screen.height);
  stealthOverride(screen, 'availWidth', () => fp.screen.availWidth);
  stealthOverride(screen, 'availHeight', () => fp.screen.availHeight);
  stealthOverride(screen, 'colorDepth', () => fp.screen.colorDepth);
  Object.defineProperty(window, 'devicePixelRatio', { get: () => fp.screen.pixelRatio, configurable: true });
  Object.defineProperty(window, 'outerWidth', { get: () => fp.screen.width + 16, configurable: true });
  Object.defineProperty(window, 'outerHeight', { get: () => fp.screen.height + 88, configurable: true });
  
  // ===== 4. LANGUAGE & TIMEZONE =====
  stealthOverride(navigator, 'language', () => fp.locale.language);
  stealthOverride(navigator, 'languages', () => Object.freeze([...fp.locale.languages]));
  
  const origDTF = Intl.DateTimeFormat;
  const newDTF = function DateTimeFormat(...args) {
    if (new.target) {
      if (args.length > 1 && args[1]) {
        args[1] = Object.assign({}, args[1], { timeZone: args[1].timeZone || fp.locale.timezone });
      } else {
        args[1] = { timeZone: fp.locale.timezone };
      }
      return new origDTF(...args);
    }
    if (args.length > 1 && args[1]) {
      args[1] = Object.assign({}, args[1], { timeZone: args[1].timeZone || fp.locale.timezone });
    } else {
      args[1] = { timeZone: fp.locale.timezone };
    }
    return origDTF(...args);
  };
  newDTF.prototype = origDTF.prototype;
  newDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
  Object.defineProperty(newDTF, 'name', { value: 'DateTimeFormat', configurable: true });
  Object.defineProperty(newDTF, 'length', { value: 0, configurable: true });
  makeNative(newDTF, 'DateTimeFormat');
  Intl.DateTimeFormat = newDTF;

  const origResolvedOptions = origDTF.prototype.resolvedOptions;
  const patchedResolvedOptions = function resolvedOptions() {
    const result = origResolvedOptions.call(this);
    result.timeZone = fp.locale.timezone;
    return result;
  };
  makeNative(patchedResolvedOptions, 'resolvedOptions');
  origDTF.prototype.resolvedOptions = patchedResolvedOptions;
  
  // Dynamic timezone offset that respects DST — compute from Intl API
  const _origDateGetTZOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    try {
      // Use the spoofed timezone to compute the correct offset for THIS date
      const fmt = new origDTF('en-US', {
        timeZone: fp.locale.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(this);
      const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
      const tzYear = get('year'), tzMonth = get('month') - 1, tzDay = get('day');
      const tzHour = get('hour') === 24 ? 0 : get('hour'), tzMin = get('minute'), tzSec = get('second');
      const tzDate = new Date(Date.UTC(tzYear, tzMonth, tzDay, tzHour, tzMin, tzSec));
      return Math.round((tzDate.getTime() - this.getTime()) / -60000);
    } catch(e) {
      return _origDateGetTZOffset.call(this);
    }
  };
  
  // ===== 5. CANVAS FINGERPRINT =====
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  
  function addCanvasNoise(imageData) {
    const seed = fp.canvas.noiseSeed;
    const intensity = fp.canvas.noiseIntensity;
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = ((Math.sin(seed * (i + 1) * 12.9898) * 43758.5453) % 1) * intensity * 255;
      data[i] = Math.min(255, Math.max(0, data[i] + noise));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise * 0.7));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise * 0.5));
      // Ensure non-zero pixels have full opacity (Sannysoft test expects A=255 for visible pixels)
      if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) {
        data[i + 3] = 255;
      }
    }
    return imageData;
  }
  
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imageData = origGetImageData.apply(this, args);
    return addCanvasNoise(imageData);
  };
  
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        // Non-destructive: create offscreen canvas with noise, read from that
        const offscreen = document.createElement('canvas');
        offscreen.width = this.width;
        offscreen.height = this.height;
        const offCtx = offscreen.getContext('2d');
        offCtx.drawImage(this, 0, 0);
        const imageData = origGetImageData.call(offCtx, 0, 0, offscreen.width, offscreen.height);
        addCanvasNoise(imageData);
        offCtx.putImageData(imageData, 0, 0);
        return origToDataURL.apply(offscreen, args);
      }
    } catch(e) {}
    return origToDataURL.apply(this, args);
  };

  HTMLCanvasElement.prototype.toBlob = function(cb, ...args) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const offscreen = document.createElement('canvas');
        offscreen.width = this.width;
        offscreen.height = this.height;
        const offCtx = offscreen.getContext('2d');
        offCtx.drawImage(this, 0, 0);
        const imageData = origGetImageData.call(offCtx, 0, 0, offscreen.width, offscreen.height);
        addCanvasNoise(imageData);
        offCtx.putImageData(imageData, 0, 0);
        return origToBlob.call(offscreen, cb, ...args);
      }
    } catch(e) {}
    return origToBlob.call(this, cb, ...args);
  };
  
  // ===== 6. WEBGL FINGERPRINT =====
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    const ext = this.getExtension('WEBGL_debug_renderer_info');
    if (ext) {
      if (param === ext.UNMASKED_VENDOR_WEBGL) return fp.webgl.vendor;
      if (param === ext.UNMASKED_RENDERER_WEBGL) return fp.webgl.renderer;
    }
    return origGetParameter.call(this, param);
  };
  
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      const ext = this.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        if (param === ext.UNMASKED_VENDOR_WEBGL) return fp.webgl.vendor;
        if (param === ext.UNMASKED_RENDERER_WEBGL) return fp.webgl.renderer;
      }
      return origGetParameter2.call(this, param);
    };
  }
  
  // ===== 7. WEBRTC MASKING =====
  // A REAL Chrome always emits host + srflx candidates. Forcing iceTransportPolicy='relay'
  // or stripping host candidates entirely is ITSELF a strong bot signal (LinkedIn/Cloudflare
  // specifically look for this pattern). Instead we rewrite the host candidate's IP
  // to a deterministic fake local IP — the presence of a host candidate is preserved,
  // but the real LAN IP is never exposed.
  const fakeLocalIp = '192.168.' + (Math.floor(Math.abs(fp.canvas.noiseSeed * 255)) % 255) + '.' + (Math.floor(Math.abs(fp.canvas.noiseSeed * 12345)) % 254 + 1);
  if (window.RTCPeerConnection) {
    const OrigRTCPC = window.RTCPeerConnection;
    const rewriteCandidate = function(cand) {
      if (!cand || !cand.candidate) return cand;
      const c = cand.candidate;
      if (c.indexOf('typ host') !== -1) {
        // Replace any local IPv4 / IPv6 with fake local IPv4
        const rewritten = c.replace(/(\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b)|([a-f0-9:]+:[a-f0-9:]+)/gi, fakeLocalIp);
        try {
          return new RTCIceCandidate({
            candidate: rewritten,
            sdpMid: cand.sdpMid,
            sdpMLineIndex: cand.sdpMLineIndex,
            usernameFragment: cand.usernameFragment,
          });
        } catch(e) { return cand; }
      }
      return cand;
    };
    const patchedRTCPC = function RTCPeerConnection(config, constraints) {
      const pc = new OrigRTCPC(config, constraints);

      // Wrap addEventListener to rewrite candidates in-flight
      const origAddEventListener = pc.addEventListener.bind(pc);
      pc.addEventListener = function(type, listener, options) {
        if (type === 'icecandidate' && typeof listener === 'function') {
          const wrapped = function(event) {
            if (event.candidate) {
              const rewritten = rewriteCandidate(event.candidate);
              // Emit a synthetic event with the rewritten candidate
              const evt = Object.assign({}, event, { candidate: rewritten });
              listener.call(this, evt);
            } else {
              listener.call(this, event);
            }
          };
          return origAddEventListener(type, wrapped, options);
        }
        return origAddEventListener(type, listener, options);
      };

      // onicecandidate setter
      let _onicecandidateFn = null;
      Object.defineProperty(pc, 'onicecandidate', {
        get: () => _onicecandidateFn,
        set: (fn) => {
          _onicecandidateFn = fn;
          if (fn) {
            origAddEventListener('icecandidate', function(event) {
              if (event.candidate) {
                const rewritten = rewriteCandidate(event.candidate);
                const evt = Object.assign({}, event, { candidate: rewritten });
                fn.call(pc, evt);
              } else {
                fn.call(pc, event);
              }
            });
          }
        },
        configurable: true,
      });

      // Also rewrite the SDP in createOffer/createAnswer (some detectors read SDP directly)
      const origCreateOffer = pc.createOffer.bind(pc);
      pc.createOffer = function(...args) {
        return origCreateOffer(...args).then((offer) => {
          if (offer && offer.sdp) {
            offer.sdp = offer.sdp.replace(/c=IN IP4 (?:\\d{1,3}\\.){3}\\d{1,3}/g, 'c=IN IP4 ' + fakeLocalIp);
          }
          return offer;
        });
      };

      return pc;
    };
    patchedRTCPC.prototype = OrigRTCPC.prototype;
    patchedRTCPC.generateCertificate = OrigRTCPC.generateCertificate;
    makeNative(patchedRTCPC, 'RTCPeerConnection');
    window.RTCPeerConnection = patchedRTCPC;
    if (window.webkitRTCPeerConnection) {
      window.webkitRTCPeerConnection = patchedRTCPC;
    }
  }
  
  // ===== 8. AUDIO FINGERPRINT =====
  const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
  const origGetFloatTimeDomainData = AnalyserNode.prototype.getFloatTimeDomainData;
  
  AnalyserNode.prototype.getFloatFrequencyData = function(array) {
    origGetFloatFrequencyData.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] += ((Math.sin(fp.audio.noiseSeed * (i + 1)) * 43758.5453) % 1) * fp.audio.noiseIntensity;
    }
  };
  
  AnalyserNode.prototype.getFloatTimeDomainData = function(array) {
    origGetFloatTimeDomainData.call(this, array);
    for (let i = 0; i < array.length; i++) {
      array[i] += ((Math.sin(fp.audio.noiseSeed * (i + 1)) * 43758.5453) % 1) * fp.audio.noiseIntensity;
    }
  };
  
  if (typeof OfflineAudioContext !== 'undefined') {
    const origStartRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function() {
      return origStartRendering.call(this).then(buffer => {
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          const data = buffer.getChannelData(ch);
          for (let i = 0; i < data.length; i++) {
            data[i] += ((Math.sin(fp.audio.noiseSeed * (i + 1) * (ch + 1)) * 43758.5453) % 1) * fp.audio.noiseIntensity;
          }
        }
        return buffer;
      });
    };
  }
  
  // ===== 9. FONTS =====
  if (document.fonts && document.fonts.check) {
    const origCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      const fontName = font.replace(/["']/g, '').split(',').map(f => f.trim());
      for (const f of fontName) {
        const baseName = f.replace(/\\d+px\\s*/i, '').trim();
        if (fp.fonts.some(allowed => allowed.toLowerCase() === baseName.toLowerCase())) {
          return origCheck(font, text);
        }
      }
      return false;
    };
  }
  
  // ===== 10. MEDIA DEVICES =====
  // Real Chrome returns deviceId = '' BEFORE user grants mic/cam permission.
  // After permission, real IDs appear (64-char hex). Returning fake hex-like IDs
  // without permission is itself a bot signal. Mirror Chrome's behavior:
  // default deviceId = '' until the user grants permission.
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const fpSeed = fp.canvas.noiseSeed;
    const stableId = (prefix, i) => {
      // 64-char hex, stable per profile + slot (matches real Chrome format)
      let s = prefix + i + fpSeed.toString(36);
      let out = '';
      for (let k = 0; k < 64; k++) {
        s = (Math.sin(s.length * (k + 1) * 12.9898) * 43758.5453).toString();
        out += Math.floor(Math.abs(parseFloat(s.split('.')[1]) || 0) * 16).toString(16).slice(-1);
      }
      return out;
    };
    // Before permission: deviceId='' (real Chrome behavior). We keep IDs empty
    // so unconsented fingerprinting can't uniquely identify the profile through
    // enumerateDevices — which is EXACTLY what real Chrome does.
    navigator.mediaDevices.enumerateDevices = async function() {
      const devices = [];
      for (let i = 0; i < fp.mediaDevices.audioInputs; i++) {
        devices.push({ deviceId: '', kind: 'audioinput', label: '', groupId: '',
                       toJSON: () => ({ deviceId: '', kind: 'audioinput', label: '', groupId: '' }) });
      }
      for (let i = 0; i < fp.mediaDevices.audioOutputs; i++) {
        devices.push({ deviceId: '', kind: 'audiooutput', label: '', groupId: '',
                       toJSON: () => ({ deviceId: '', kind: 'audiooutput', label: '', groupId: '' }) });
      }
      for (let i = 0; i < fp.mediaDevices.videoInputs; i++) {
        devices.push({ deviceId: '', kind: 'videoinput', label: '', groupId: '',
                       toJSON: () => ({ deviceId: '', kind: 'videoinput', label: '', groupId: '' }) });
      }
      return devices;
    };
    // Expose stableId for potential post-permission use (not active by default)
    navigator.mediaDevices.__stableId = stableId;
  }
  
  // ===== 11. CLIENT RECTS =====
  const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function() {
    const rect = origGetBoundingClientRect.call(this);
    const noise = fp.clientRects.noiseIntensity;
    const seed = fp.clientRects.noiseSeed;
    const hash = Math.sin(seed * (rect.x + rect.y + 1) * 12.9898) * 43758.5453;
    const n = (hash % 1) * noise;
    return new DOMRect(rect.x + n, rect.y + n, rect.width + n, rect.height + n);
  };
  
  const origGetClientRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function() {
    const rects = origGetClientRects.call(this);
    const noise = fp.clientRects.noiseIntensity;
    const seed = fp.clientRects.noiseSeed;
    const result = [];
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      const hash = Math.sin(seed * (rect.x + rect.y + i + 1) * 12.9898) * 43758.5453;
      const n = (hash % 1) * noise;
      result.push(new DOMRect(rect.x + n, rect.y + n, rect.width + n, rect.height + n));
    }
    return result;
  };

  // ===== 12. PLUGINS =====
  // Real Chrome (130+) exposes exactly TWO plugins, both using the same
  // internal-pdf-viewer filename. Having 5 is a strong bot signal.
  const pluginData = [
    { name: 'PDF Viewer',        filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
  ];
  // Build a PluginArray-like object that passes instanceof checks
  const fakePlugins = Object.create(PluginArray.prototype);
  pluginData.forEach((p, i) => {
    const plugin = Object.create(Plugin.prototype);
    Object.defineProperties(plugin, {
      name: { value: p.name, enumerable: true },
      filename: { value: p.filename, enumerable: true },
      description: { value: p.description, enumerable: true },
      length: { value: p.length, enumerable: true },
    });
    fakePlugins[i] = plugin;
  });
  Object.defineProperty(fakePlugins, 'length', { value: pluginData.length, enumerable: true });
  fakePlugins.item = function(i) { return this[i] || null; };
  fakePlugins.namedItem = function(name) {
    for (let i = 0; i < this.length; i++) { if (this[i].name === name) return this[i]; }
    return null;
  };
  fakePlugins.refresh = function() {};
  stealthOverride(navigator, 'plugins', () => fakePlugins);

  // mimeTypes matching plugins
  const fakeMimeTypes = Object.create(MimeTypeArray.prototype);
  const mimeType = Object.create(MimeType.prototype);
  Object.defineProperties(mimeType, {
    type: { value: 'application/pdf', enumerable: true },
    suffixes: { value: 'pdf', enumerable: true },
    description: { value: 'Portable Document Format', enumerable: true },
    enabledPlugin: { value: fakePlugins[0], enumerable: true },
  });
  fakeMimeTypes[0] = mimeType;
  Object.defineProperty(fakeMimeTypes, 'length', { value: 1, enumerable: true });
  fakeMimeTypes.item = function(i) { return this[i] || null; };
  fakeMimeTypes.namedItem = function(name) { return name === 'application/pdf' ? this[0] : null; };
  stealthOverride(navigator, 'mimeTypes', () => fakeMimeTypes);

  // navigator.pdfViewerEnabled — always true for modern Chrome
  stealthOverride(navigator, 'pdfViewerEnabled', () => true);

  // ===== 13. NAVIGATOR OVERRIDES =====
  // Override on prototype so getOwnPropertyDescriptor(navigator, 'webdriver') returns undefined
  stealthOverride(navigator, 'webdriver', () => false);
  // Also delete the instance property if Playwright set it
  try { delete navigator.webdriver; delete Object.getPrototypeOf(navigator).webdriver; } catch(e) {}
  Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => false, configurable: true, enumerable: true });
  stealthOverride(navigator, 'vendor', () => 'Google Inc.');
  stealthOverride(navigator, 'appName', () => 'Netscape');
  stealthOverride(navigator, 'appCodeName', () => 'Mozilla');

  // navigator.connection — Google checks existence; Playwright doesn't emulate it.
  // Values are derived from the per-profile noiseSeed so they stay stable between
  // launches but differ across profiles (all profiles having rtt:50 downlink:10
  // is itself a cluster-level bot signal).
  if (!navigator.connection) {
    try {
      // Stable per-profile: rtt in {50, 100, 150}, downlink in {5, 10, 15}
      const rttOpts = [50, 100, 150];
      const downOpts = [5, 10, 15];
      const seedI = Math.floor(Math.abs(fp.canvas.noiseSeed * 10000));
      const connValues = {
        rtt: rttOpts[seedI % rttOpts.length],
        type: 'wifi',
        saveData: false,
        downlink: downOpts[(seedI >> 2) % downOpts.length],
        effectiveType: '4g',
        onchange: null,
      };
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          ...connValues,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return false; },
        }),
        configurable: true,
      });
    } catch(e) {}
  }

  // window.Notification.permission — Playwright sets to "denied"; real Chrome = "default"
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    }
  } catch(e) {}

  // ===== 14. PERMISSIONS (Google checks this — Playwright returns "denied" by default) =====
  if (navigator.permissions && navigator.permissions.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(parameters) {
      const name = parameters && parameters.name;
      // Return "prompt" for notifications (automation returns "denied" → detected)
      if (name === 'notifications' || name === 'push') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery(parameters);
    };
  }

  // ===== 15. window.chrome (absent in Playwright — Google immediately detects) =====
  // IMPORTANT: Do NOT add window.chrome.app. Real Chrome on regular sites
  // does not expose window.chrome.app (it only exists inside extensions).
  // Adding it is a strong bot signal that LinkedIn/Cloudflare check for.
  if (!window.chrome) {
    const chrome = {
      runtime: {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        connect: function() { return { postMessage: function() {}, disconnect: function() {}, onMessage: { addListener: function() {}, removeListener: function() {} }, onDisconnect: { addListener: function() {}, removeListener: function() {} } }; },
        sendMessage: function() {},
        onMessage: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; } },
        onConnect: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; } },
        onInstalled: { addListener: function() {}, removeListener: function() {}, hasListener: function() { return false; } },
        id: undefined,
      },
      loadTimes: function() {
        return {
          requestTime: performance.timing ? performance.timing.navigationStart / 1000 : Date.now() / 1000,
          startLoadTime: performance.timing ? performance.timing.navigationStart / 1000 : Date.now() / 1000,
          commitLoadTime: performance.timing ? performance.timing.responseStart / 1000 : Date.now() / 1000,
          finishDocumentLoadTime: 0,
          finishLoadTime: 0,
          firstPaintTime: 0,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
          npnNegotiatedProtocol: 'http/1.1',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'http/1.1',
        };
      },
      csi: function() {
        return {
          startE: performance.timing ? performance.timing.navigationStart : Date.now(),
          onloadT: performance.timing ? performance.timing.loadEventEnd : Date.now(),
          pageT: Date.now() - (performance.timing ? performance.timing.navigationStart : Date.now()),
          tran: 15,
        };
      },
    };
    try {
      Object.defineProperty(window, 'chrome', { value: chrome, writable: false, enumerable: true, configurable: false });
    } catch(e) {
      window.chrome = chrome;
    }
  }

  // ===== 15b. WORKER PROPAGATION =====
  // Web Workers inherit their OWN Navigator instance which is NOT touched by
  // addInitScript — so navigator.webdriver / hardwareConcurrency / userAgent
  // leak their REAL values inside workers. LinkedIn in particular spins up a
  // worker just to read these. We intercept the Worker constructor and prepend
  // a same-fingerprint patch before the worker's original code.
  if (typeof Worker !== 'undefined') {
    const OrigWorker = Worker;
    const WORKER_PATCH = 'try {' +
      '  var _fp = ' + ${JSON.stringify(JSON.stringify({
        userAgent: fingerprint.userAgent,
        platform: fingerprint.platform,
        hardwareConcurrency: fingerprint.hardware.cpuCores,
        deviceMemory: fingerprint.hardware.memoryGb,
        maxTouchPoints: fingerprint.hardware.maxTouchPoints,
        language: fingerprint.locale.language,
        languages: fingerprint.locale.languages,
        timezone: fingerprint.locale.timezone,
      }))} + ';' +
      '  if (typeof navigator !== "undefined") {' +
      '    var proto = Object.getPrototypeOf(navigator);' +
      '    var defs = {' +
      '      webdriver: { get: function() { return false; }, configurable: true },' +
      '      userAgent: { get: function() { return _fp.userAgent; }, configurable: true },' +
      '      platform:  { get: function() { return _fp.platform; }, configurable: true },' +
      '      language:  { get: function() { return _fp.language; }, configurable: true },' +
      '      languages: { get: function() { return Object.freeze([].concat(_fp.languages)); }, configurable: true },' +
      '      hardwareConcurrency: { get: function() { return _fp.hardwareConcurrency; }, configurable: true },' +
      '      deviceMemory: { get: function() { return _fp.deviceMemory; }, configurable: true },' +
      '      maxTouchPoints: { get: function() { return _fp.maxTouchPoints; }, configurable: true }' +
      '    };' +
      '    for (var k in defs) {' +
      '      try { Object.defineProperty(proto || navigator, k, defs[k]); } catch(e) {}' +
      '    }' +
      '  }' +
      '  if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {' +
      '    var _origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;' +
      '    Intl.DateTimeFormat.prototype.resolvedOptions = function() {' +
      '      var r = _origResolved.call(this);' +
      '      r.timeZone = _fp.timezone;' +
      '      return r;' +
      '    };' +
      '  }' +
      '  try {' +
      '    Object.keys(self).filter(function(k){return k.indexOf("__playwright")===0 || k.indexOf("cdc_")===0 || k.indexOf("__pw_")===0;}).forEach(function(k){ try { delete self[k]; } catch(e){} });' +
      '  } catch(e) {}' +
      '} catch(e) {}';
    const makeBlobWorker = function(scriptURL, options) {
      try {
        if (typeof scriptURL === 'string' && !scriptURL.startsWith('blob:') && !scriptURL.startsWith('data:')) {
          const absolute = new URL(scriptURL, location.href).href;
          const isModule = options && options.type === 'module';
          // For classic workers we use importScripts; for module workers we use dynamic import().
          const body = isModule
            ? WORKER_PATCH + '\\nimport(' + JSON.stringify(absolute) + ');'
            : WORKER_PATCH + '\\nimportScripts(' + JSON.stringify(absolute) + ');';
          const blob = new Blob([body], { type: 'application/javascript' });
          return new OrigWorker(URL.createObjectURL(blob), options);
        }
      } catch(e) {}
      return new OrigWorker(scriptURL, options);
    };
    const PatchedWorker = function Worker(scriptURL, options) {
      return makeBlobWorker(scriptURL, options);
    };
    PatchedWorker.prototype = OrigWorker.prototype;
    makeNative(PatchedWorker, 'Worker');
    try { window.Worker = PatchedWorker; } catch(e) {}
  }

  // ===== 16. Remove Playwright/CDP traces =====
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__pwInitScripts;
  // Remove ALL Playwright/CDP binding markers (not just the first)
  try {
    Object.keys(window).filter(k => k.startsWith('__playwright') || k.startsWith('__pw_')).forEach(k => { try { delete window[k]; } catch(e) {} });
  } catch(e) {}
  // Remove CDP-specific markers
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array; } catch(e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise; } catch(e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol; } catch(e) {}
  // Remove any remaining cdc_ prefixed properties (ChromeDriver markers)
  try {
    Object.keys(window).filter(k => k.startsWith('cdc_')).forEach(k => { try { delete window[k]; } catch(e) {} });
  } catch(e) {}
  // Remove document markers
  try { delete document.__selenium_evaluate; } catch(e) {}
  try { delete document.__selenium_unwrapped; } catch(e) {}
  try { delete document.__webdriver_evaluate; } catch(e) {}
  try { delete document.__webdriver_script_fn; } catch(e) {}
  try { delete document.__fxdriver_evaluate; } catch(e) {}
  try { delete document.__driver_evaluate; } catch(e) {}
  try { delete document.__driver_unwrapped; } catch(e) {}
  try { delete document.$chrome_asyncScriptInfo; } catch(e) {}
  try { delete document.$cdc_asdjflasutopfhvcZLmcfl_; } catch(e) {}
})();
`;
}

module.exports = {
  generateFingerprint,
  generateFingerprintFromUA,
  parseUA,
  buildInjectionScript,
  FINGERPRINT_PROFILES,
  getLocaleByCountry,
  countryCodeToFlag,
};
