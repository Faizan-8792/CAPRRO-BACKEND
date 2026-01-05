// Shared loader utility for capro-backend public pages
(function () {
  const ID = 'capro-backend-loader-v1';

  function create() {
    let el = document.getElementById(ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ID;
    el.className = 'capro-loader-overlay';
    el.style.display = 'none';

    const box = document.createElement('div');
    box.className = 'capro-loader-box';

    const spinner = document.createElement('div');
    spinner.className = 'capro-loader-spinner';

    const msg = document.createElement('div');
    msg.className = 'capro-loader-message';
    msg.textContent = 'Loading...';

    box.appendChild(spinner);
    box.appendChild(msg);
    el.appendChild(box);
    document.body.appendChild(el);
    return el;
  }

  function caproShowLoader(message) {
    try {
      const el = create();
      const msg = el.querySelector('.capro-loader-message');
      if (message) msg.textContent = message;
      el.style.display = 'flex';
    } catch (e) {
      console.warn('caproShowLoader error', e);
    }
  }

  function caproHideLoader() {
    try {
      const el = document.getElementById(ID);
      if (el) el.style.display = 'none';
    } catch (e) {
      // ignore
    }
  }

  window.caproShowLoader = caproShowLoader;
  window.caproHideLoader = caproHideLoader;
})();
