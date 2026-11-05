import os
import smtplib
import ssl
from email.message import EmailMessage


class MailError(Exception):
    pass


def send_reset_code(to_email, full_name, code):
    host = os.getenv("SMTP_HOST", "").strip()
    if not host:
        raise MailError(
            "Email sending is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, "
            "SMTP_PASSWORD and SMTP_FROM in .env, then restart the backend."
        )

    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USERNAME", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM", "").strip() or username

    message = EmailMessage()
    message["Subject"] = "Your SolarSense AI password reset code"
    message["From"] = sender
    message["To"] = to_email
    message.set_content(
        f"Hello {full_name},\n\n"
        f"Your SolarSense AI password reset code is: {code}\n\n"
        "The code expires in 10 minutes. If you did not request a reset, ignore this email.\n"
    )

    context = ssl.create_default_context()
    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=15, context=context) as server:
                if username:
                    server.login(username, password)
                server.send_message(message)
        else:
            with smtplib.SMTP(host, port, timeout=15) as server:
                server.starttls(context=context)
                if username:
                    server.login(username, password)
                server.send_message(message)
    except (smtplib.SMTPException, OSError) as error:
        raise MailError("The reset email could not be sent. Check the SMTP settings in .env.") from error
