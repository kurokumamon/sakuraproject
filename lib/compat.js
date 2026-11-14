// 古い iPhone (iOS 12〜) の Safari にない機能をおぎなう。
// app.js のいちばん最初に読みこむこと。

if (!Element.prototype.replaceChildren) {
  const replaceChildren = function () {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append.apply(this, arguments);
  };
  Element.prototype.replaceChildren = replaceChildren;
  DocumentFragment.prototype.replaceChildren = replaceChildren;
}

if (!Object.fromEntries) {
  Object.fromEntries = function (entries) {
    const o = {};
    Array.from(entries).forEach(function (e) { o[e[0]] = e[1]; });
    return o;
  };
}

// ランダムな ID (crypto.randomUUID は iOS 15.4 から)
export function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
