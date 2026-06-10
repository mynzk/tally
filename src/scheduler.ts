// scheduler.ts

/**
 * 创建不同引擎的批处理触发器
 */
export function createScheduler(type: "promise" | "channel" | "microtask" = "channel") {
  if (type === "channel") {
    // MessageChannel 方案（宏任务，高频、繁重计算表单首选，防止输入卡顿）
    const channel = new MessageChannel();
    return (flush: () => void) => {
      channel.port1.onmessage = () => {
        flush();
      };
      channel.port2.postMessage(null);
    };
  }

  if (type === "promise") {
    // Promise.resolve() 方案（微任务，追求最快的响应速度）
    const resolvedPromise = Promise.resolve();
    return (flush: () => void) => {
      resolvedPromise.then(flush);
    };
  }

  // 默认 queueMicrotask
  return (flush: () => void) => {
    queueMicrotask(flush);
  };
}
