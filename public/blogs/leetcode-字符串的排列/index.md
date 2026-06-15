## 题目描述

给你两个字符串 `s1` 和 `s2` ，写一个函数来判断 `s2` 是否包含 `s1`** **的 排列。如果是，返回 `true` ；否则，返回 `false` 。

换句话说，`s1` 的排列之一是 `s2` 的 **子串** 。

 

**示例 1：**

```
**输入：**s1 = "ab" s2 = "eidbaooo"
**输出：**true
**解释：**s2 包含 s1 的排列之一 ("ba").
```

**示例 2：**

```
**输入：**s1= "ab" s2 = "eidboaoo"
**输出：**false
```

 

**提示：**

	- `1 <= s1.length, s2.length <= 104`

	- `s1` 和 `s2` 仅包含小写字母

## 解法

```java
class Solution {
     public boolean checkInclusion(String s1, String s2) {
        if(s1==null){
            return true;
        }
         int n = s2.length();
        int length = s1.length();
        if(n<length){
            return false;
        }
        
        Map<Character,Integer> mapS1=new HashMap<>();
        for (Character s: s1.toCharArray()){
            mapS1.put(s,mapS1.getOrDefault(s,0)+1);
        }
        char[] arrayS2 = s2.toCharArray();
       
        for (int i=0;i<length-1;i++){
            mapS1.put(arrayS2[i],mapS1.getOrDefault(arrayS2[i],0)-1);
            if (mapS1.get(arrayS2[i])==0){
                mapS1.remove(arrayS2[i]);
            }
        }
        for (int j=length-1;j<n;j++){
            mapS1.put(arrayS2[j],mapS1.getOrDefault(arrayS2[j],0)-1);
            if (mapS1.get(arrayS2[j])==0){
                mapS1.remove(arrayS2[j]);
            }
            if (mapS1.isEmpty()){
                return true;
            }
            mapS1.put(arrayS2[j-length+1],mapS1.getOrDefault(arrayS2[j-length+1],0)+1);
            if (mapS1.get(arrayS2[j-length+1])==0){
                mapS1.remove(arrayS2[j-length+1]);
            }
        }
        return false;
    }
}
```
