export const abort = Symbol("abort");

export const depthFirst = async <T extends unknown>(
  x: Iterable<T>,
  f: (v: T) => Promise<Iterator<T> | typeof abort>
): Promise<void | typeof abort> => {
  const stack = [];
  for (let v of x) {
    const add0 = await f(v);
    if (add0 == abort) return abort;
    const add = add0 as Iterator<T>;
    stack.push(add);
  }
  stack.reverse();
  while (stack.length > 0) {
    const { done, value } = await stack[stack.length - 1].next();
    if (done) {
      stack.splice(stack.length - 1, 1);
      continue;
    }
    const out0 = await f(value);
    if (out0 == abort) return abort;
    const out = out0 as Iterator<T>;
    stack.push(out);
  }
};
