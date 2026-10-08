import type { ReactNode } from "react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { TAGLINE } from "./docs";

export const OG_SIZE = { width: 1200, height: 630 };

/** The header's lucide hash, drawn for image routes. */
export function Mark({ size, color }: { size: number; color: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="2 2 20 20"
      fill="none"
      stroke={color}
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </svg>
  );
}

const geistMono = (weight: "Regular" | "SemiBold"): Promise<Buffer> =>
  readFile(join(process.cwd(), "node_modules/geist/dist/fonts/geist-mono", `GeistMono-${weight}.ttf`));

/** Plain text on the page background: the wordmark, then a title over the tagline. */
export async function ogImage({ title }: { title?: string }): Promise<ImageResponse> {
  const [regular, semibold] = await Promise.all([geistMono("Regular"), geistMono("SemiBold")]);
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: 80,
        background: "#fafafa",
        color: "#000",
        fontFamily: "Geist Mono",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 40, fontWeight: 600 }}>
        <Mark size={40} color="#000" />
        vboard
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {title ? <div style={{ fontSize: 72, fontWeight: 600, lineHeight: 1.1 }}>{title}</div> : null}
        <div style={title ? { fontSize: 32, color: "#6e6e6e" } : { fontSize: 64, fontWeight: 600, lineHeight: 1.15 }}>
          {TAGLINE}
        </div>
      </div>
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        { name: "Geist Mono", data: regular, weight: 400 },
        { name: "Geist Mono", data: semibold, weight: 600 },
      ],
    },
  );
}
