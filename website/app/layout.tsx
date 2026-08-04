import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

function requestOrigin(host: string | null, protocol: string | null) {
  const normalizedHost = host?.split(",")[0]?.trim() || "localhost:3000";
  const normalizedProtocol = protocol?.split(",")[0]?.trim() || "https";

  try {
    return new URL(`${normalizedProtocol}://${normalizedHost}`);
  } catch {
    return new URL("https://lorebit.invalid");
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const metadataBase = requestOrigin(
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host"),
    requestHeaders.get("x-forwarded-proto"),
  );

  return {
    metadataBase,
    title: {
      default: "lorebit · RAG knowledge infrastructure",
      template: "%s · lorebit",
    },
    description:
      "面向通用 RAG 的知识基础设施：完整 pipeline、可替换数据库适配和可引用的上下文交付。",
    openGraph: {
      type: "website",
      locale: "zh_CN",
      siteName: "lorebit",
      title: "lorebit · RAG knowledge infrastructure",
      description:
        "面向通用 RAG 的知识基础设施：完整 pipeline、可替换数据库适配和可引用的上下文交付。",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "lorebit" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "lorebit · RAG knowledge infrastructure",
      description: "RAG pipeline、adapter contracts、context with citations。",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="site-body">{children}</body>
    </html>
  );
}
