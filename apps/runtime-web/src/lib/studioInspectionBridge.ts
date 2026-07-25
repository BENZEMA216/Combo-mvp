/**
 * Fixed Studio inspection helper injected into a sandboxed HTML artifact.
 *
 * The host never sends a selector or script into the frame. The helper only walks a
 * fixed allowlist of semantic elements and reports either an authored data-combo-key
 * or a bounded structural path.
 */
export const STUDIO_INSPECTION_BRIDGE = String.raw`
<style id="combo-studio-inspection-style">
  .combo-studio-hovered {
    outline: 2px dashed #b8563f !important;
    outline-offset: 3px !important;
  }
  .combo-studio-selected {
    outline: 2px solid #b8563f !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 5px rgba(184, 86, 63, 0.14) !important;
  }
  html.combo-studio-inspection-enabled,
  html.combo-studio-inspection-enabled * {
    cursor: crosshair !important;
  }
</style>
<script>
(() => {
  if (window.__comboStudioInspectionV1) return;
  Object.defineProperty(window, '__comboStudioInspectionV1', { value: true });

  const MAX_ELEMENTS = 80;
  const TARGET_SELECTOR = [
    '[data-combo-key]',
    'main', 'header', 'footer', 'nav', 'section', 'article', 'aside',
    'form', 'fieldset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
    'button', 'a[href]', 'input', 'textarea', 'select', 'label', '[role]'
  ].join(',');
  const IGNORED_TAGS = new Set(['html', 'body', 'head', 'script', 'style', 'link', 'meta', 'br']);
  const generatedKeys = new WeakMap();
  let generatedKeyCount = 0;
  let enabled = false;
  let selectedKey = null;
  let hovered = null;
  let manifestFrame = null;
  let suppressedTarget = null;

  const clean = (value, maxLength) =>
    String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);

  const canInspect = (element) =>
    element instanceof Element && !IGNORED_TAGS.has(element.tagName.toLowerCase());

  const authoredKey = (element) => clean(element.getAttribute('data-combo-key'), 120);

  const keyFor = (element) => {
    const authored = authoredKey(element);
    if (authored) return authored;
    const existing = generatedKeys.get(element);
    if (existing) return existing;
    generatedKeyCount += 1;
    const generated = 'auto-' + generatedKeyCount.toString(36);
    generatedKeys.set(element, generated);
    return generated;
  };

  const pathFor = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 7) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName)
        : [];
      const index = Math.max(0, siblings.indexOf(current)) + 1;
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      current = current.parentElement;
    }
    return clean(['body'].concat(parts).join(' > '), 240);
  };

  const roleFor = (element) => {
    const explicit = clean(element.getAttribute('role'), 60);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'form') return 'form';
    if (tag === 'nav') return 'navigation';
    if (['main', 'section', 'article', 'aside', 'header', 'footer'].includes(tag)) return 'region';
    return null;
  };

  const describe = (element) => {
    if (!canInspect(element)) return null;
    const stableKey = Boolean(authoredKey(element));
    const key = keyFor(element);
    const text = clean(element.innerText || element.textContent, 240);
    const controlLabel = element.labels
      ? clean(Array.from(element.labels).map((label) => label.textContent || '').join(' '), 160)
      : '';
    const label = clean(
      element.getAttribute('data-combo-label') ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        controlLabel ||
        element.getAttribute('placeholder') ||
        text ||
        key,
      160,
    );
    return {
      key,
      label: label || key,
      role: roleFor(element),
      text,
      tagName: element.tagName.toLowerCase().slice(0, 32),
      path: pathFor(element),
      stableKey,
    };
  };

  const candidates = () =>
    Array.from(document.querySelectorAll(TARGET_SELECTOR)).filter(canInspect).slice(0, MAX_ELEMENTS);

  const candidateForTarget = (target) => {
    if (!(target instanceof Element)) return null;
    const authored = target.closest('[data-combo-key]');
    if (authored && canInspect(authored)) return authored;
    const fallback = target.closest(TARGET_SELECTOR);
    return fallback && canInspect(fallback) ? fallback : null;
  };

  const post = (payload) => window.parent.postMessage(payload, '*');

  const syncSelected = () => {
    document.querySelectorAll('.combo-studio-selected').forEach((element) => {
      element.classList.remove('combo-studio-selected');
    });
    if (!selectedKey) return;
    candidates().find((element) => keyFor(element) === selectedKey)?.classList.add(
      'combo-studio-selected',
    );
  };

  const publishManifest = () => {
    post({
      type: 'combo:element-manifest',
      version: 1,
      elements: candidates().map(describe).filter(Boolean),
    });
  };

  const scheduleManifest = () => {
    if (manifestFrame !== null) return;
    manifestFrame = window.requestAnimationFrame(() => {
      manifestFrame = null;
      publishManifest();
      syncSelected();
    });
  };

  const clearHover = () => {
    hovered?.classList.remove('combo-studio-hovered');
    hovered = null;
  };

  const stopEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const select = (element) => {
    const description = describe(element);
    if (!description) return false;
    selectedKey = description.key;
    syncSelected();
    post({ type: 'combo:element-select', version: 1, element: description });
    return true;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    if (event.data.type !== 'combo:inspection-state' || event.data.version !== 1) return;
    enabled = event.data.enabled === true;
    selectedKey =
      typeof event.data.selectedElementKey === 'string'
        ? clean(event.data.selectedElementKey, 120)
        : null;
    document.documentElement.classList.toggle('combo-studio-inspection-enabled', enabled);
    if (!enabled) clearHover();
    syncSelected();
    publishManifest();
  });

  document.addEventListener('pointerover', (event) => {
    if (!enabled) return;
    const candidate = candidateForTarget(event.target);
    if (!candidate || candidate === hovered) return;
    clearHover();
    hovered = candidate;
    hovered.classList.add('combo-studio-hovered');
  }, true);

  document.addEventListener('pointerout', (event) => {
    if (!enabled) return;
    const candidate = candidateForTarget(event.target);
    if (candidate && candidate === hovered) clearHover();
  }, true);

  document.addEventListener('pointerdown', (event) => {
    suppressedTarget = null;
    if (!enabled) return;
    const candidate = candidateForTarget(event.target);
    if (!candidate) return;
    stopEvent(event);
    if (select(candidate)) suppressedTarget = candidate;
  }, true);

  document.addEventListener('click', (event) => {
    const candidate = candidateForTarget(event.target);
    if (
      suppressedTarget &&
      candidate &&
      (suppressedTarget === candidate || suppressedTarget.contains(candidate))
    ) {
      stopEvent(event);
      suppressedTarget = null;
      return;
    }
    suppressedTarget = null;
    if (!enabled || !candidate) return;
    stopEvent(event);
    select(candidate);
  }, true);

  const ready = () => {
    publishManifest();
    post({ type: 'combo:inspection-ready', version: 1 });
    if (document.body) {
      new MutationObserver(scheduleManifest).observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
</script>
`;

export function injectStudioInspectionBridge(content: string): string {
  if (typeof DOMParser === 'undefined') return `${content}${STUDIO_INSPECTION_BRIDGE}`;

  // Parse as inert HTML instead of searching text for </body>. A generated artifact may legally
  // contain that byte sequence inside a script, style, template, or comment; textual insertion
  // would split the artifact at the wrong location and could change its behavior.
  const document = new DOMParser().parseFromString(content, 'text/html');
  const bridge = document.createElement('template');
  bridge.innerHTML = STUDIO_INSPECTION_BRIDGE;
  document.body.append(bridge.content.cloneNode(true));
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
