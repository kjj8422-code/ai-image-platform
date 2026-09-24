"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 모든 화면 맨 위에 붙는 메뉴. 예전에는 화면마다 "다른 화면으로 가는 링크"가 한두 개씩
// 흩어져 있어서, 한번 들어가면 홈으로 돌아갈 길이 없는 화면이 있었다.
const LINKS = [
  { href: "/", label: "홈" },
  { href: "/shorts/product", label: "쿠팡 꿀템" },
  { href: "/generate", label: "이미지 생성" },
  { href: "/gallery", label: "갤러리" },
  { href: "/thumbnail", label: "썸네일" },
  { href: "/shorts", label: "사진 쇼츠" },
  { href: "/shorts/video", label: "AI 영상 쇼츠" },
];

// 지금 보고 있는 화면의 메뉴를 고른다. /shorts/video는 /shorts로도 시작하므로
// 가장 길게 들어맞는 메뉴 하나만 켠다.
const activeHref = (pathname: string): string =>
  LINKS.map((link) => link.href)
    .filter((href) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)))
    .sort((a, b) => b.length - a.length)[0] ?? "";

export const NavBar = () => {
  const pathname = usePathname() ?? "/";
  if (pathname === "/login") {
    return null;
  }
  const active = pathname.startsWith("/edit/") ? "/gallery" : activeHref(pathname);

  return (
    <nav className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-black/90">
      <ul className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-3 py-2 text-sm">
        {LINKS.map((link) => (
          <li key={link.href} className="shrink-0">
            <Link
              href={link.href}
              aria-current={link.href === active ? "page" : undefined}
              className={`block rounded-full px-3 py-1 transition-colors ${
                link.href === active
                  ? "bg-black font-medium text-white dark:bg-white dark:text-black"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
};
