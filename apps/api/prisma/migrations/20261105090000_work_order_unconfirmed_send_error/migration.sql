-- A mail error on a work order was recorded as "send-failed" whatever the mail
-- driver could tell of it, and the code now means the error came before the
-- message was handed to the mail server. A row written under the old reading
-- may be one the server took (a connection that broke after the message was
-- sent), so it becomes "delivery-unconfirmed": nobody knows, and the handler is
-- told to ask the contractor rather than that it did not go out. Runs before the
-- code that reads "send-failed" as known not sent is deployed.
UPDATE "work_order"
SET "deliveryFailure" = 'delivery-unconfirmed'
WHERE "deliveryStatus" = 'FAILED'
  AND "deliveryFailure" = 'send-failed';
