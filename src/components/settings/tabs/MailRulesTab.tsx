import { Section } from "./shared";
import { LabelEditor } from "@/components/settings/LabelEditor";
import { FilterEditor } from "@/components/settings/FilterEditor";
import { SmartLabelEditor } from "@/components/settings/SmartLabelEditor";
import { SmartFolderEditor } from "@/components/settings/SmartFolderEditor";
import { QuickStepEditor } from "@/components/settings/QuickStepEditor";

export function MailRulesTab() {
  return (
    <>
      <Section title="Labels">
        <p className="text-xs text-text-tertiary mb-3">
          Create, rename, recolor, delete, or reorder your Gmail labels.
        </p>
        <LabelEditor />
      </Section>

      <Section title="Filters">
        <p className="text-xs text-text-tertiary mb-3">
          Filters automatically apply actions to new incoming emails during sync.
        </p>
        <FilterEditor />
      </Section>

      <Section title="Smart Labels">
        <p className="text-xs text-text-tertiary mb-3">
          Describe what emails should get a label using plain English. AI automatically labels matching emails during sync.
        </p>
        <SmartLabelEditor />
      </Section>

      <Section title="Smart Folders">
        <p className="text-xs text-text-tertiary mb-3">
          Smart folders are saved searches that automatically show matching emails. Use search operators like{" "}
          <code className="bg-bg-tertiary px-1 rounded">is:unread</code>,{" "}
          <code className="bg-bg-tertiary px-1 rounded">from:</code>,{" "}
          <code className="bg-bg-tertiary px-1 rounded">has:attachment</code>,{" "}
          <code className="bg-bg-tertiary px-1 rounded">after:</code>.
        </p>
        <SmartFolderEditor />
      </Section>

      <Section title="Quick Steps">
        <p className="text-xs text-text-tertiary mb-3">
          Quick steps let you chain multiple actions together into a single click.
          Apply them from the right-click menu on any thread.
        </p>
        <QuickStepEditor />
      </Section>
    </>
  );
}
