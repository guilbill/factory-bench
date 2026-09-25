import { genericMemo, useFieldValue, useTranslate } from "ra-core";
import type { AnchorHTMLAttributes } from "react";
import React from "react";

import { cn } from "@/lib/utils";
import type { FieldProps } from "@/lib/field.type";

const PhoneFieldImpl = <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RecordType extends Record<string, any> = Record<string, any>,
>(
  inProps: PhoneFieldProps<RecordType>,
) => {
  const { className, empty, defaultValue, source, record, ...rest } = inProps;
  const value = useFieldValue({ defaultValue, source, record });
  const translate = useTranslate();

  if (value == null) {
    if (!empty) {
      return null;
    }

    return (
      <span className={className} {...rest}>
        {typeof empty === "string" ? translate(empty, { _: empty }) : empty}
      </span>
    );
  }

  return (
    <a
      className={cn("underline hover:no-underline", className)}
      href={`tel:${value}`}
      onClick={stopPropagation}
      {...rest}
    >
      {value}
    </a>
  );
};
PhoneFieldImpl.displayName = "PhoneFieldImpl";

/**
 * Displays a phone number as a clickable tel link.
 *
 * Click events are prevented from bubbling up, making it safe to use in DataTable rows with rowClick.
 * To be used with RecordField or DataTable.Col components, or anywhere a RecordContext is available.
 *
 * @example
 * import { List, DataTable, PhoneField } from '@/components/admin';
 *
 * const UserList = () => (
 *   <List>
 *     <DataTable>
 *       <DataTable.Col source="name" />
 *       <DataTable.Col source="phone" field={PhoneField} />
 *     </DataTable>
 *   </List>
 * );
 */
export const PhoneField = genericMemo(PhoneFieldImpl);

export interface PhoneFieldProps<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RecordType extends Record<string, any> = Record<string, any>,
> extends FieldProps<RecordType>,
    AnchorHTMLAttributes<HTMLAnchorElement> {}

// useful to prevent click bubbling in a DataTable with rowClick
const stopPropagation = (e: React.MouseEvent<HTMLAnchorElement>) =>
  e.stopPropagation();
