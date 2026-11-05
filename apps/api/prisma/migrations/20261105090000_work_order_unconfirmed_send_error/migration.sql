-- A mail error on a work order or on an answer from the board's shared mailbox
-- was recorded as "send-failed" whatever the mail driver could tell of it, and
-- the code now means the error came before the message was handed to the mail
-- server. A row written under the old reading may be one the server took (a
-- connection that broke after the message was sent), so in both tables it
-- becomes that table's code for unconfirmed: nobody knows, and the handler or
-- the board is told to check with the recipient rather than that it did not go
-- out. Runs before the code that reads "send-failed" as known not sent is
-- deployed.
UPDATE "work_order"
SET "deliveryFailure" = 'delivery-unconfirmed'
WHERE "deliveryStatus" = 'FAILED'
  AND "deliveryFailure" = 'send-failed';

UPDATE "board_mailbox_message"
SET "deliveryFailure" = 'reply-delivery-unconfirmed'
WHERE "deliveryStatus" = 'FAILED'
  AND "deliveryFailure" = 'send-failed';
