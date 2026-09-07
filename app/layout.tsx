import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '가림PDF - 학교 기록 비식별화 도구',
  description: '학교생활기록부와 대입전형자료의 학생·교직원 식별정보를 서버 업로드 없이 안전하게 가립니다.',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
