import type { ReactNode, Ref } from "react";
import { PixelFrame } from "./components";

type PageTitleProps = {
  title: string;
  eyebrow: string;
  icon: ReactNode;
  className?: string;
  headingRef?: Ref<HTMLHeadingElement>;
};

export function PageTitle({
  title,
  eyebrow,
  icon,
  className = "",
  headingRef,
}: PageTitleProps) {
  return (
    <div className={`page-title ${className}`}>
      <span className="page-title-mark has-surface" aria-hidden="true">
        <PixelFrame />
        {icon}
      </span>
      <div className="page-title-copy">
        <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
          {title}
        </h1>
        <span className="page-title-edition" aria-hidden="true">
          {eyebrow}
        </span>
      </div>
    </div>
  );
}

export function PageHeader({
  description,
  action,
  ...titleProps
}: PageTitleProps & {
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-copy">
        <PageTitle {...titleProps} />
        {description && <p className="page-description">{description}</p>}
      </div>
      {action}
    </header>
  );
}
