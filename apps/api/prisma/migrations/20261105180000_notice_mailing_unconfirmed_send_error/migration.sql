-- A mail error on a news mailing's email copy or on a meeting notice's copy was
-- recorded as "send-failed" whatever the mail driver could tell of it, and the
-- code now means the error came before the message was handed to the mail
-- server. A row written under the old reading may be one the server took (a
-- connection that broke after the message was sent), so it becomes
-- "delivery-unconfirmed": nobody knows. The status stays FAILED, so a member
-- the board is shown as not reached by a notice is still shown so.
--
-- Email rows only. A news mailing's text message rows keep "send-failed", which
-- for them still means the SMS gateway answered with an error.
UPDATE "news_delivery"
SET "failureReason" = 'delivery-unconfirmed'
WHERE "channel" = 'EMAIL'
  AND "status" = 'FAILED'
  AND "failureReason" = 'send-failed';

UPDATE "meeting_notice_delivery"
SET "failureReason" = 'delivery-unconfirmed'
WHERE "channel" = 'EMAIL'
  AND "status" = 'FAILED'
  AND "failureReason" = 'send-failed';
