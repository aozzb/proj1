import { applyTestEnv } from './testEnv';

// Must run before any src module (which reads env at import time) is loaded.
applyTestEnv();
