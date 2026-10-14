// Shared by every vitest file (vite.config.ts `setupFiles`).
// Screen tests wait for things on screen (findBy…, waitFor). Testing Library's default wait is
// 1 second, which a 35-answer import can exceed when the machine is busy (audit L17). Only the
// wait limit is raised; no check is loosened, and a test that passes still passes as fast.
import { configure } from '@testing-library/dom';

configure({ asyncUtilTimeout: 10_000 });
