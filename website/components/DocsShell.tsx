import Link from "next/link";
import type { ReactNode } from "react";

import { navigationGroups } from "../content/docs";
import { SiteHeader } from "./SiteHeader";

type DocsShellProps = {
  activeHref: string;
  children: ReactNode;
};

function DocumentationNavigation({ activeHref }: { activeHref: string }) {
  return (
    <nav className="docs-nav" aria-label="文档目录">
      {navigationGroups.map((group) => (
        <section className="docs-nav__group" key={group.label}>
          <h2>{group.label}</h2>
          <ul>
            {group.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={activeHref === item.href ? "page" : undefined}
                  className={activeHref === item.href ? "is-current" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

export function DocsShell({ activeHref, children }: DocsShellProps) {
  return (
    <>
      <SiteHeader current="docs" />
      <main id="main-content" className="docs-layout">
        <a className="skip-link" href="#docs-content">
          跳到正文
        </a>
        <aside className="docs-sidebar">
          <p className="docs-sidebar__eyebrow">lorebit docs</p>
          <DocumentationNavigation activeHref={activeHref} />
        </aside>
        <details className="docs-mobile-nav">
          <summary>文档目录</summary>
          <DocumentationNavigation activeHref={activeHref} />
        </details>
        <article id="docs-content" className="docs-content">
          {children}
        </article>
      </main>
      <footer className="site-footer">
        <p>lorebit 是设计中的通用 RAG 知识基础设施。</p>
        <p>Apache-2.0 · API 与 npm 包尚未发布</p>
      </footer>
    </>
  );
}

