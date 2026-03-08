import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Sidebar } from "@/components/common/Sidebar";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Agent Platform v2",
  description: "Agent orchestration dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div className="flex">
          <Sidebar />
          <main className="flex-1 p-8 bg-gray-50 min-h-screen">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
