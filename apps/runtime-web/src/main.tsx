import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { installGlobalClientErrorHandlers } from './api/telemetry.js';
import {
  ReleaseMetadataFailure,
  ReleaseMetadataLoading,
  ReleaseMetadataProvider,
  resolveRuntimeReleaseMetadata,
} from './shell/releaseIdentity.js';
import { ThemeProvider } from './theme/ThemeProvider.js';
import { createRuntimeQueryClient } from './queryClient.js';
import './styles.css';
import './design-claude.css';

installGlobalClientErrorHandlers();

const queryClient = createRuntimeQueryClient();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const root = createRoot(rootEl);

root.render(
  <StrictMode>
    <ThemeProvider>
      <ReleaseMetadataLoading />
    </ThemeProvider>
  </StrictMode>,
);

async function start(): Promise<void> {
  try {
    const metadata = await resolveRuntimeReleaseMetadata({ development: import.meta.env.DEV });
    root.render(
      <StrictMode>
        <ThemeProvider>
          <ReleaseMetadataProvider metadata={metadata}>
            <QueryClientProvider client={queryClient}>
              <App />
            </QueryClientProvider>
          </ReleaseMetadataProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  } catch {
    root.render(
      <StrictMode>
        <ThemeProvider>
          <ReleaseMetadataFailure />
        </ThemeProvider>
      </StrictMode>,
    );
  }
}

void start();
