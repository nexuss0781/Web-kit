use anyhow::{anyhow, bail, Result};
use std::net::IpAddr;
use url::Url;

pub async fn validate_public_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|e| anyhow!("invalid URL: {e}"))?;

    if !matches!(url.scheme(), "http" | "https") {
        bail!("only http and https URLs are allowed")
    }
    if url.username() != "" || url.password().is_some() {
        bail!("URLs containing credentials are not allowed")
    }

    let host = url.host_str().ok_or_else(|| anyhow!("URL has no host"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("unsupported URL port"))?;

    if let Ok(ip) = host.parse::<IpAddr>() {
        reject_private_ip(ip)?;
        return Ok(url);
    }

    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| anyhow!("DNS lookup failed: {e}"))?;
    let mut found = false;
    for address in addresses {
        found = true;
        reject_private_ip(address.ip())?;
    }
    if !found {
        bail!("host did not resolve")
    }
    Ok(url)
}

fn reject_private_ip(ip: IpAddr) -> Result<()> {
    let blocked = match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
                || v4.octets() == [192, 0, 0, 0]
                || v4.octets() == [192, 0, 0, 9]
                || v4.octets() == [192, 0, 0, 10]
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
        }
    };

    if blocked {
        bail!("target resolves to a private, local, multicast, or reserved address")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::reject_private_ip;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn rejects_private_ipv4() {
        assert!(reject_private_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))).is_err());
        assert!(reject_private_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))).is_err());
        assert!(reject_private_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))).is_err());
    }

    #[test]
    fn rejects_private_ipv6() {
        assert!(reject_private_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)).is_err());
        assert!(reject_private_ip("fc00::1".parse().unwrap()).is_err());
    }
}

#[cfg(test)]
mod extended_tests {
    use super::reject_private_ip;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn rejects_additional_reserved_and_multicast_addresses() {
        for ip in [
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 0, 0, 9)),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            IpAddr::V6("ff02::1".parse().unwrap()),
            IpAddr::V6("fe80::1".parse().unwrap()),
        ] {
            assert!(reject_private_ip(ip).is_err(), "{ip}");
        }
    }

    #[test]
    fn accepts_a_public_documentation_address() {
        assert!(reject_private_ip("93.184.216.34".parse().unwrap()).is_ok());
        assert!(reject_private_ip("2001:4860:4860::8888".parse().unwrap()).is_ok());
    }
}
