// Мова для власних вікон основного процесу: «Update ready», вибір теки
// розширення, повідомлення вебзапуску. Інтерфейс вікна перекладає сам
// renderer/i18n.js; сюди він лише повідомляє вибір із Settings ('auto' | 'en' | 'zh-CN').
const { app } = require('electron');

let chosen = 'auto';

const ZH = {
  'Restart now': '立即重启',
  'Later': '稍后',
  'Update ready': '更新已就绪',
  'Version {0} is downloaded.': '版本 {0} 已下载。',
  'Restart app to install update.': '重启应用以安装更新。',
  'Pick an unpacked extension folder': '选择未打包的扩展程序文件夹',
};

function setLanguage(value) {
  chosen = ['en', 'zh-CN'].includes(value) ? value : 'auto';
}

function language() {
  if (chosen !== 'auto') return chosen;
  try {
    return String(app.getLocale() || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  } catch (_) {
    return 'en';
  }
}

/** t('Version {0} is downloaded.', '1.2.16') */
function t(source, ...values) {
  const target = language() === 'zh-CN' && ZH[source] ? ZH[source] : source;
  return target.replace(/\{(\d+)\}/g, (_, i) => (values[Number(i)] != null ? values[Number(i)] : ''));
}

module.exports = { setLanguage, language, t };
