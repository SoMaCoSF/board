"use client";
import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

export type NavGroup = {
  label: string | null;
  links: { href: string; title: string }[];
};

const MENU = "data-menu-open";

const closeMenu = (): void => document.body.removeAttribute(MENU);

const subscribe = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { attributeFilter: [MENU] });
  return () => observer.disconnect();
};

/** Opens the sidebar over the page on narrow screens; any navigation closes it. */
export function MenuToggle(): ReactNode {
  const pathname = usePathname();
  const open = useSyncExternalStore(subscribe, () => document.body.hasAttribute(MENU), () => false);
  useEffect(closeMenu, [pathname]);

  return (
    <button
      type="button"
      className="menu-toggle"
      aria-label={open ? "Close menu" : "Open menu"}
      aria-expanded={open}
      onClick={() => document.body.toggleAttribute(MENU)}
    >
      {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
    </button>
  );
}

export function Sidebar({ groups }: { groups: NavGroup[] }): ReactNode {
  const pathname = usePathname();
  return (
    <nav className="sidebar" aria-label="Docs">
      {groups.map((group) => (
        <section key={group.label ?? ""}>
          {group.label ? <p className="label">{group.label}</p> : null}
          <ul>
            {group.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={link.href === pathname ? "page" : undefined}
                  onClick={closeMenu}
                >
                  {link.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
