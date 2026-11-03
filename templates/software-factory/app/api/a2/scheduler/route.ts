// A Vercel Queues trigger (vercel.json) makes this function private: only the queue calls it.
export { scheduler as POST } from "@/app/api/board/[[...path]]/route";
