import { describe, expect, it } from 'vitest';
import { injectStudioInspectionBridge } from './studioInspectionBridge.js';

describe('injectStudioInspectionBridge', () => {
  it('does not mistake a closing-body literal inside script or comments for the document boundary', () => {
    const content = `<!doctype html>
      <html>
        <body>
          <script>window.template = "</body>";</script>
          <!-- </body> is example text, not the boundary -->
          <main data-combo-key="result">Result</main>
        </body>
      </html>`;

    const injected = injectStudioInspectionBridge(content);
    const document = new DOMParser().parseFromString(injected, 'text/html');
    const scripts = [...document.querySelectorAll('script')];

    expect(scripts[0]?.textContent).toContain('window.template = "</body>"');
    expect(document.querySelector('main[data-combo-key="result"]')).not.toBeNull();
    expect(document.querySelector('#combo-studio-inspection-style')).not.toBeNull();
    expect(scripts.at(-1)?.textContent).toContain('__comboStudioInspectionV1');
    expect(injected.match(/combo-studio-inspection-style/g)).toHaveLength(1);
  });
});
