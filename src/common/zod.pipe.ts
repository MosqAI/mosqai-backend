import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/** Validates and parses a request body or query against a zod schema. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.infer<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: z.treeifyError(result.error),
      });
    }
    return result.data;
  }
}
