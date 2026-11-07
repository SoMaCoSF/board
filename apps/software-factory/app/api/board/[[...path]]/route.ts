import { factory } from "./factory";

// SSE streams close just before this, and clients reconnect from their cursor.
export const maxDuration = 300;

export const GET = factory.fetch, POST = factory.fetch;
