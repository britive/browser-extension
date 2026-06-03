(() => {
  if (window.__britiveAutofillInstalled) return;
  window.__britiveAutofillInstalled = true;

  function isVisible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function setInputValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  function isFillable(el) {
    if (!el || !isVisible(el)) return false;
    if (el.matches && el.matches("textarea")) return true;
    if (!el.matches || !el.matches("input")) return false;
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes((el.type || "").toLowerCase());
  }

  function fieldText(el) {
    const attrs = [
      el.name,
      el.id,
      el.autocomplete,
      el.placeholder,
      el.getAttribute("aria-label"),
    ];
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) attrs.push(label.textContent);
    }
    if (el.labels) {
      Array.from(el.labels).forEach((label) => attrs.push(label.textContent));
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) attrs.push(wrappingLabel.textContent);
    return attrs.filter(Boolean).join(" ").toLowerCase();
  }

  function isPasswordField(el) {
    const type = (el.type || "").toLowerCase();
    const text = fieldText(el);
    return (
      type === "password" ||
      /(current-password|new-password|password|passcode|pass phrase|passphrase)/i.test(
        text,
      )
    );
  }

  function isOtpField(el) {
    return /(one-time-code|otp|totp|mfa|2fa|code|verification)/i.test(
      fieldText(el),
    );
  }

  function isUsernameField(el) {
    const text = fieldText(el);
    return (
      !isPasswordField(el) &&
      !isOtpField(el) &&
      /(user|email|login|account|identifier)/i.test(text)
    );
  }

  function findUsernameField(fields, passwordField, activeField) {
    const candidates = fields.filter(
      (el) => !isPasswordField(el) && !isOtpField(el),
    );
    if (activeField && candidates.includes(activeField)) return activeField;
    const preferred = candidates.find(isUsernameField);
    if (preferred) return preferred;
    if (!passwordField) return candidates[0] || null;
    const beforePassword = candidates.filter(
      (el) =>
        el.compareDocumentPosition(passwordField) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return beforePassword[beforePassword.length - 1] || candidates[0] || null;
  }

  function findPasswordField(fields, activeField) {
    if (activeField && isPasswordField(activeField)) return activeField;
    return fields.find(isPasswordField) || null;
  }

  function findOtpField(fields, activeField) {
    if (activeField && isOtpField(activeField)) return activeField;
    return fields.find(isOtpField) || null;
  }

  function autofillCredential(credential) {
    const fields = Array.from(
      document.querySelectorAll("input, textarea"),
    ).filter(isFillable);
    const activeField = isFillable(document.activeElement)
      ? document.activeElement
      : null;
    const passwordField = findPasswordField(fields, activeField);
    const usernameField = findUsernameField(fields, passwordField, activeField);
    const otpField = credential.otp ? findOtpField(fields, activeField) : null;
    const result = { username: false, password: false, otp: false };

    if (usernameField && credential.username) {
      setInputValue(usernameField, credential.username);
      result.username = true;
    }
    if (passwordField && credential.password) {
      setInputValue(passwordField, credential.password);
      result.password = true;
    }
    if (otpField && credential.otp) {
      setInputValue(otpField, credential.otp);
      result.otp = true;
    }

    return result;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action !== "britiveAutofill") return false;
    try {
      sendResponse({
        success: true,
        result: autofillCredential(message.credential || {}),
      });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  });
})();
