import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { handleQueuedApplication, type CloudRunOutcome, type CloudRunPorts } from "./queued-run.js";

export type ReceivedApplicationMessage = { body: string; receiptHandle: string };

/** A short-lived Fargate task receives at most one FIFO application message. */
export class SqsApplicationQueueReceiver {
  constructor(private readonly sqs: Pick<SQSClient, "send">, private readonly queueUrl: string) {
    const url = new URL(queueUrl);
    if (url.protocol !== "https:" || !/^sqs\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
      || !/^\/\d{12}\/openapply-[a-z0-9-]+-application\.fifo$/.test(url.pathname)
      || url.search || url.hash) throw new Error("Invalid application queue URL");
  }

  async receiveOne(): Promise<ReceivedApplicationMessage | null> {
    const response = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
      VisibilityTimeout: 900,
    }));
    const messages = response.Messages ?? [];
    if (messages.length === 0) return null;
    if (messages.length !== 1 || !messages[0]?.Body || !messages[0].ReceiptHandle) {
      throw new Error("SQS returned an incomplete application message");
    }
    return { body: messages[0].Body, receiptHandle: messages[0].ReceiptHandle };
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    if (!receiptHandle) throw new Error("SQS receipt handle is required");
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle }));
  }

  /** The broker has already made needs-human durable before this delete. */
  async acknowledgeHandoff(receiptHandle: string): Promise<void> {
    return this.acknowledge(receiptHandle);
  }
}

/** A task exits after one message. Nonterminal outcomes stay visible for safe
 * redelivery or an explicit reconciliation; this function never deletes them. */
export async function runOneApplicationQueueTick(
  receiver: SqsApplicationQueueReceiver,
  ports: Omit<CloudRunPorts, "queue">,
): Promise<CloudRunOutcome | "empty"> {
  const message = await receiver.receiveOne();
  if (!message) return "empty";
  return handleQueuedApplication(message, { ...ports, queue: receiver });
}
