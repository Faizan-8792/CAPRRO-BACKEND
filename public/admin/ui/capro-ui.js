/* CA PRO UI - dialogs, toasts and icons for every web surface (DS17).
 *
 * One source: design/ui/capro-ui.js, copied by design/build-ui.mjs into the extension
 * (audit-nlp-extension/ui/) and the admin panel (capro-backend/public/admin/ui/). A classic script,
 * no dependencies, no inline handlers (the extension's CSP forbids them), and every string a caller
 * passes is set with textContent, never parsed as HTML: a client or supplier name is untrusted.
 *
 *   CaproUI.confirm({ title, body, confirmLabel, cancelLabel, tone, requireText, details }) -> Promise<boolean>
 *   CaproUI.alert({ title, body, okLabel, tone })                                         -> Promise<void>
 *   CaproUI.prompt({ title, body, label, value, placeholder, confirmLabel, cancelLabel })  -> Promise<string|null>
 *   CaproUI.toast({ message, tone, actionLabel, onAction, timeout })                      -> { close() }
 *   CaproUI.icon(name, { size, label, className })                                        -> SVGElement
 *
 * The rules (DS17 research): a dialog says what will happen to what, and its buttons name the action
 * ("Turn on maintenance", never "OK"); a destructive dialog opens on the safe button and Enter never
 * confirms it; a firm-wide or irreversible action can ask for a word to be typed first; Esc and the
 * close button cancel; focus returns to whatever opened it; one dialog at a time. A toast confirms
 * something just done: success and information leave by themselves after six seconds (and wait
 * while hovered or focused), a problem stays until it is dismissed.
 */
(function () {
  "use strict";

  if (window.CaproUI && window.CaproUI.version) return;

  var SVG_NS = "http://www.w3.org/2000/svg";

  // The sprite sits beside this script, wherever a surface keeps it.
  var scriptUrl = (document.currentScript && document.currentScript.src) || "";
  var spriteUrl = scriptUrl ? scriptUrl.replace(/[^/]*$/, "") + "capro-icons.svg" : "ui/capro-icons.svg";

  function icon(name, options) {
    var opts = options || {};
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "cp-icon" + (opts.size ? " cp-icon--" + opts.size : "") + (opts.className ? " " + opts.className : ""));
    svg.setAttribute("focusable", "false");
    if (opts.label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", String(opts.label));
    } else {
      svg.setAttribute("aria-hidden", "true");
    }
    var use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", spriteUrl + "#" + String(name));
    svg.appendChild(use);
    return svg;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // Body text may be a string (one paragraph per blank-line-separated block) or a list of strings.
  function paragraphs(body) {
    if (body === undefined || body === null || body === "") return [];
    var blocks = Array.isArray(body) ? body : String(body).split(/\n\s*\n/);
    return blocks
      .map(function (text) { return String(text).trim(); })
      .filter(Boolean)
      .map(function (text) { return el("p", null, text); });
  }

  var ids = 0;
  var queue = Promise.resolve();

  // One dialog at a time: each request waits for the one before it to close.
  function enqueue(open) {
    var next = queue.then(open, open);
    queue = next.then(function () {}, function () {});
    return next;
  }

  var TONE_ICON = { danger: "warning", warning: "warning-circle", info: "info", success: "check-circle", primary: "question" };

  function openDialog(spec) {
    return new Promise(function (resolve) {
      var id = "cp-dialog-" + (++ids);
      var opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      var tone = spec.tone || "primary";

      var dialog = el("dialog", "cp-dialog" + (spec.size ? " cp-dialog--" + spec.size : ""));
      dialog.setAttribute("data-tone", tone);
      dialog.setAttribute("aria-labelledby", id + "-title");
      if (spec.kind === "confirm") dialog.setAttribute("role", "alertdialog");

      var header = el("div", "cp-dialog__header");
      var mark = el("span", "cp-dialog__icon");
      mark.appendChild(icon(TONE_ICON[tone] || "info"));
      header.appendChild(mark);
      var title = el("h2", "cp-dialog__title", spec.title || "");
      title.id = id + "-title";
      header.appendChild(title);
      dialog.appendChild(header);

      var body = el("div", "cp-dialog__body");
      body.id = id + "-body";
      paragraphs(spec.body).forEach(function (p) { body.appendChild(p); });
      if (Array.isArray(spec.details) && spec.details.length) {
        var list = el("ul", "cp-dialog__details");
        spec.details.forEach(function (item) { list.appendChild(el("li", null, item)); });
        body.appendChild(list);
      }
      if (body.childNodes.length && !spec.details) dialog.setAttribute("aria-describedby", body.id);

      var input = null;
      if (spec.kind === "prompt" || spec.requireText) {
        var field = el("div", "cp-field");
        var label = el("label", "cp-label", spec.requireText ? (spec.requireLabel || "Type " + spec.requireText + " to confirm") : (spec.label || ""));
        label.htmlFor = id + "-input";
        input = el("input", "cp-input");
        input.id = id + "-input";
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        if (spec.placeholder) input.placeholder = spec.placeholder;
        if (spec.value) input.value = String(spec.value);
        field.appendChild(label);
        field.appendChild(input);
        body.appendChild(field);
      }
      dialog.appendChild(body);

      var footer = el("div", "cp-dialog__footer");
      var cancel = null;
      if (spec.kind !== "alert") {
        cancel = el("button", "cp-btn", spec.cancelLabel || "Cancel");
        cancel.type = "button";
        footer.appendChild(cancel);
      }
      var confirmClass = tone === "danger" ? "cp-btn cp-btn--danger" : "cp-btn cp-btn--primary";
      var confirm = el("button", confirmClass, spec.confirmLabel || (spec.kind === "alert" ? "Close" : "Continue"));
      confirm.type = "button";
      footer.appendChild(confirm);
      dialog.appendChild(footer);

      function typedOk() {
        if (!spec.requireText) return true;
        return input && input.value.trim() === String(spec.requireText);
      }

      function syncConfirm() {
        var ok = typedOk() && (spec.kind !== "prompt" || !spec.required || (input && input.value.trim()));
        confirm.disabled = !ok;
      }

      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        try { dialog.close(); } catch (_) { /* already closed */ }
        dialog.remove();
        if (opener && opener.isConnected && typeof opener.focus === "function") {
          try { opener.focus({ preventScroll: true }); } catch (_) { opener.focus(); }
        }
        resolve(value);
      }

      confirm.addEventListener("click", function () {
        if (confirm.disabled) return;
        if (spec.kind === "prompt") finish(input ? input.value : "");
        else finish(spec.kind === "alert" ? undefined : true);
      });
      if (cancel) cancel.addEventListener("click", function () { finish(spec.kind === "prompt" ? null : false); });

      // Esc cancels here, and the page handles it, so a popup that hosts the dialog stays open.
      dialog.addEventListener("cancel", function (event) {
        event.preventDefault();
        finish(spec.kind === "prompt" ? null : spec.kind === "alert" ? undefined : false);
      });
      dialog.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(spec.kind === "prompt" ? null : spec.kind === "alert" ? undefined : false);
          return;
        }
        // Enter confirms only where confirming is the safe default: never in a destructive dialog.
        if (event.key === "Enter" && event.target === input && tone !== "danger" && !confirm.disabled) {
          event.preventDefault();
          confirm.click();
        }
      });

      if (input) {
        input.addEventListener("input", syncConfirm);
        syncConfirm();
      }

      document.body.appendChild(dialog);
      try {
        dialog.showModal();
      } catch (_) {
        dialog.setAttribute("open", "");
      }

      // A destructive dialog opens on the safe button; a typed confirmation on its field.
      var first = input || (tone === "danger" ? cancel || confirm : confirm);
      setTimeout(function () { if (!settled) first.focus(); }, 0);
    });
  }

  function confirmDialog(options) {
    var spec = Object.assign({ kind: "confirm" }, options || {});
    return enqueue(function () { return openDialog(spec); });
  }

  function alertDialog(options) {
    var spec = Object.assign({ kind: "alert", tone: "info" }, options || {});
    return enqueue(function () { return openDialog(spec); });
  }

  function promptDialog(options) {
    var spec = Object.assign({ kind: "prompt" }, options || {});
    return enqueue(function () { return openDialog(spec); });
  }

  // ---------- Toasts ----------

  var region = null;
  var errorRegion = null;

  function regions() {
    if (region && region.isConnected) return;
    var host = el("div", "cp-toasts");
    region = el("div", "cp-toasts__polite");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    errorRegion = el("div", "cp-toasts__assertive");
    errorRegion.setAttribute("role", "alert");
    errorRegion.setAttribute("aria-live", "assertive");
    host.appendChild(region);
    host.appendChild(errorRegion);
    document.body.appendChild(host);
  }

  var TOAST_ICON = { success: "check-circle", warning: "warning-circle", critical: "x-circle", info: "info" };

  function toast(options) {
    var opts = typeof options === "string" ? { message: options } : options || {};
    var tone = opts.tone || "success";
    regions();
    var node = el("div", "cp-toast");
    node.setAttribute("data-tone", tone);
    node.appendChild(icon(TOAST_ICON[tone] || "info"));
    var text = el("div", "cp-toast__text");
    text.appendChild(el("div", null, opts.message || ""));
    if (opts.actionLabel && typeof opts.onAction === "function") {
      var action = el("button", "cp-btn cp-btn--link cp-toast__action", opts.actionLabel);
      action.type = "button";
      action.addEventListener("click", function () {
        try { opts.onAction(); } finally { close(); }
      });
      text.appendChild(action);
    }
    node.appendChild(text);
    var dismiss = el("button", "cp-btn cp-btn--ghost cp-btn--icon cp-btn--sm");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.appendChild(icon("close"));
    node.appendChild(dismiss);

    var timer = null;
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      node.setAttribute("data-leaving", "true");
      setTimeout(function () { node.remove(); }, 200);
    }
    dismiss.addEventListener("click", close);

    // Only a success or a note leaves by itself, and never while someone is reading it.
    var lasting = tone === "critical" || tone === "warning" || opts.timeout === 0;
    var wait = typeof opts.timeout === "number" && opts.timeout > 0 ? opts.timeout : 6000;
    function arm() {
      if (lasting || closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, wait);
    }
    function hold() { if (timer) clearTimeout(timer); timer = null; }
    node.addEventListener("mouseenter", hold);
    node.addEventListener("mouseleave", arm);
    node.addEventListener("focusin", hold);
    node.addEventListener("focusout", arm);

    (tone === "critical" ? errorRegion : region).appendChild(node);
    // At most three on screen: the oldest of the self-dismissing ones goes first.
    var all = document.querySelectorAll(".cp-toast:not([data-leaving])");
    if (all.length > 3) {
      for (var i = 0; i < all.length - 3; i++) {
        var oldest = all[i];
        if (oldest !== node && oldest.getAttribute("data-tone") !== "critical") oldest.setAttribute("data-leaving", "true");
        setTimeout(function (n) { return function () { if (n.getAttribute("data-leaving") === "true") n.remove(); }; }(oldest), 200);
      }
    }
    arm();
    return { close: close };
  }

  window.CaproUI = Object.freeze({
    version: 1,
    confirm: confirmDialog,
    alert: alertDialog,
    prompt: promptDialog,
    toast: toast,
    icon: icon,
    spriteUrl: function () { return spriteUrl; },
  });
})();
