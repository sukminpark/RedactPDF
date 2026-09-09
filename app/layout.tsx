import type { Metadata } from 'next';
import { deploymentAssetPath } from '@/lib/deployment-path';
import './globals.css';

export const metadata: Metadata = {
  title: '가림PDF - 학교 기록 비식별화 도구',
  description: '학교생활기록부와 대입전형자료의 학생·교직원 식별정보를 서버 업로드 없이 안전하게 가립니다.',
  metadataBase: new URL(__PUBLIC_CANONICAL_URL__),
  alternates: {
    canonical: __PUBLIC_CANONICAL_URL__,
  },
  openGraph: {
    type: 'website',
    siteName: 'AI세특',
    title: '가림PDF - 학교 기록 비식별화 도구',
    description: '학교생활기록부와 대입전형자료의 학생·교직원 식별정보를 서버 업로드 없이 안전하게 가립니다.',
    url: __PUBLIC_CANONICAL_URL__,
  },
  icons: {
    icon: deploymentAssetPath('favicon.svg'),
    shortcut: deploymentAssetPath('favicon.svg'),
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
