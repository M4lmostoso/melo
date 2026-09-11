//! Repro: DavMail answers a failed send with a 451 whose text carries the whole
//! EWS SOAP request — embedded bare LF and megabytes long. Assert lettre still
//! reports that as an error and never as a successful delivery.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::thread;

use app_lib::smtp::client::send_raw_email;
use app_lib::smtp::types::SmtpConfig;

fn spawn_davmail_like_server(reply: Vec<u8>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut w = stream.try_clone().unwrap();
        let mut r = BufReader::new(stream);
        w.write_all(b"220 davmail SMTP ready\r\n").unwrap();
        loop {
            let mut line = String::new();
            if r.read_line(&mut line).unwrap() == 0 {
                return;
            }
            let up = line.to_uppercase();
            if up.starts_with("EHLO") {
                w.write_all(b"250-davmail\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n").unwrap();
            } else if up.starts_with("AUTH") {
                w.write_all(b"235 OK\r\n").unwrap();
            } else if up.starts_with("MAIL FROM") {
                w.write_all(b"250 Sender OK\r\n").unwrap();
            } else if up.starts_with("RCPT TO") {
                w.write_all(b"250 Recipient OK\r\n").unwrap();
            } else if up.starts_with("DATA") {
                w.write_all(b"354 Start mail input; end with <CRLF>.<CRLF>\r\n").unwrap();
                // Drain until the lone dot.
                let mut buf = Vec::new();
                let mut byte = [0u8; 1];
                while r.read(&mut byte).unwrap() == 1 {
                    buf.push(byte[0]);
                    if buf.ends_with(b"\r\n.\r\n") {
                        break;
                    }
                }
                // DavMail's failure reply, verbatim in shape.
                w.write_all(&reply).unwrap();
                w.flush().unwrap();
            } else if up.starts_with("QUIT") {
                w.write_all(b"221 Bye\r\n").unwrap();
                return;
            } else {
                w.write_all(b"250 OK\r\n").unwrap();
            }
        }
    });
    port
}

fn config(port: u16) -> SmtpConfig {
    SmtpConfig {
        host: "127.0.0.1".to_string(),
        port,
        username: "landenna".to_string(),
        password: "secret".to_string(),
        security: "none".to_string(),
        auth_method: "password".to_string(),
        accept_invalid_certs: true,
    }
}

fn raw_email() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let msg = "From: Mirko <m.landenna@termomeccanica.com>\r\n\
               To: Someone <someone@example.com>\r\n\
               Subject: Test\r\n\
               Message-ID: <test@termomeccanica.com>\r\n\r\nBody\r\n";
    URL_SAFE_NO_PAD.encode(msg)
}

/// A plain, single-line 451 must be an error (sanity check on the harness).
#[tokio::test]
async fn plain_451_is_an_error() {
    let port = spawn_davmail_like_server(b"451 Error : something went wrong\r\n".to_vec());
    let result = send_raw_email(&config(port), &raw_email()).await;
    assert!(result.is_err(), "plain 451 reported as success: {result:?}");
}

/// DavMail's real reply: `"451 Error : " + e.getMessage()`, where the EWS
/// exception message embeds a bare LF and the entire SOAP request.
#[tokio::test]
async fn davmail_multiline_451_is_an_error() {
    // The real message measured 20 MB with ZERO CRLF — only bare LFs — so the
    // whole thing is a single SMTP "line" from the client parser's point of view.
    let soap = "<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><t:MimeContent>".to_string()
        + &"QUFBQUFBQUFBQUFBQUFBQQ".repeat(1_000_000)
        + "</t:MimeContent></soap:Envelope>";
    let reply = format!(
        "451 Error : ErrorMimeContentInvalid Invalid MIME content. \n request: {soap}\r\n"
    );
    let result = send_raw_email(&config(port_of(&reply)), &raw_email()).await;
    assert!(
        result.is_err(),
        "DavMail's 451 was reported as a SUCCESSFUL SEND: {result:?}"
    );
}

fn port_of(reply: &str) -> u16 {
    spawn_davmail_like_server(reply.as_bytes().to_vec())
}

/// The real incident: a 7.5 MB message whose send Exchange refuses. Same reply,
/// but now the DATA upload is the size that actually triggered it in production.
#[tokio::test]
async fn large_message_rejected_after_data_is_an_error() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let mut msg = String::from(
        "From: Mirko <m.landenna@termomeccanica.com>\r\n\
         To: Someone <someone@example.com>\r\n\
         Subject: Test\r\n\
         Message-ID: <big@termomeccanica.com>\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: text/plain\r\n\r\n",
    );
    for _ in 0..100_000 {
        msg.push_str("0123456789012345678901234567890123456789012345678901234567890123456789012345\r\n");
    }
    let raw = URL_SAFE_NO_PAD.encode(&msg);

    let reply = format!(
        "451 Error : ErrorMimeContentInvalid Invalid MIME content.  request: {}\r\n",
        "<soap:Envelope><t:MimeContent>".to_string()
            + &"QUFBQUFBQUFBQUFBQUFBQQ".repeat(1_000_000)
            + "</t:MimeContent></soap:Envelope>"
    );
    let port = spawn_davmail_like_server(reply.into_bytes());
    let result = send_raw_email(&config(port), &raw).await;
    assert!(
        result.is_err(),
        "a refused 7.5MB send was reported as delivered: {result:?}"
    );
}
