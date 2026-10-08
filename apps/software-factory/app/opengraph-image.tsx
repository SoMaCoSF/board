import type { ImageResponse } from "next/og";
import { TAGLINE } from "@/lib/docs";
import { OG_SIZE, ogImage } from "@/lib/og";

export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = TAGLINE;

export default function Image(): Promise<ImageResponse> {
  return ogImage({});
}
