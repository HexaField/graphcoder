fn check(item: u32) -> Result<u32, String> {
    if item == 0 {
        return Err("zero".to_string());
    }
    Ok(item)
}

pub fn run(items: &[u32]) -> Result<u32, String> {
    let mut total = 0;
    for item in items {
        match check(*item) {
            Ok(v) => total += v,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}
