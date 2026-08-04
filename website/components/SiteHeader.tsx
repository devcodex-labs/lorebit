import Link from "next/link";

import { StatusBadge } from "./StatusBadge";

type SiteHeaderProps = {
  current?: "home" | "docs";
};

export function SiteHeader({ current }: SiteHeaderProps) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="brand" href="/" aria-label="lorebit 首页">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>lorebit</span>
        </Link>

        <nav className="primary-nav" aria-label="主导航">
          <Link
            className={current === "home" ? "is-current" : undefined}
            href="/"
            aria-current={current === "home" ? "page" : undefined}
          >
            概览
          </Link>
          <Link
            className={current === "docs" ? "is-current" : undefined}
            href="/docs"
            aria-current={current === "docs" ? "page" : undefined}
          >
            文档
          </Link>
          <a
            href="https://github.com/devcodex-labs/lorebit"
            target="_blank"
            rel="noreferrer"
          >
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>

        <StatusBadge>Early Preview</StatusBadge>
      </div>
    </header>
  );
}

